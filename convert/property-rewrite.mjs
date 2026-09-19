/** Syntax-aware property migration. Values and code literals are never searched/replaced. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {pageIdentity} from './tana_tine/model.mjs';

let parserPromise;
export function parser() {
  parserPromise ??= (async () => {
    const wasm = await import('../src/render/wasm/lsdoc_wasm.js');
    const source = await readFile(new URL('../src/render/wasm/lsdoc_wasm_bytes.ts', import.meta.url), 'utf8');
    const {WASM_B64} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    wasm.initSync({module: Buffer.from(WASM_B64, 'base64')});
    return raw => JSON.parse(wasm.parse_document_json(raw, false));
  })();
  return parserPromise;
}

export const keyIdentity = key => key.trim().replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[ _]/g, '-');
export const stripSpans = value => Array.isArray(value) ? value.map(stripSpans)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'span' && key !== 'span_map').map(([key, child]) => [key, stripSpans(child)])) : value;

export function rewriter(mapping) {
  const keyName = key => mapping.keys[keyIdentity(key)] ?? key;
  const pageName = name => mapping.names[pageIdentity(name)] ?? name;
  const fieldName = name => name.startsWith('prop:') ? 'prop:' + keyName(name.slice(5)) : keyName(name);
  const references = value => value.replace(/\[\[([^\[\]\r\n]+)\]\]/g, (_, name) => '[[' + pageName(name) + ']]');
  // Recognize calls before strings; a query literal containing "prop(...)" is data.
  const expression = value => value.replace(/\bprop\(\s*'((?:[^']|'')*)'\s*\)|'(?:[^']|'')*'|"(?:[^"]|"")*"/g,
    (all, name) => name === undefined ? all : "prop('" + keyName(name.replaceAll("''", "'")).replaceAll("'", "''") + "')");
  const ogExpression = value => value.replace(/\((property|property-exists)\s+([^\s()[\]"]+)|"(?:\\.|[^"\\])*"/g,
    (all, operation, key) => operation ? '(' + operation + ' ' + keyName(key) : all);

  function uniqueSegments(value, transform, identity) {
    const result = new Map();
    for (const segment of value.split(';')) {
      const updated = transform(segment), name = identity(updated);
      if (result.has(name) && result.get(name) !== updated) throw new Error('Conflicting view settings after merging property ' + name);
      result.set(name, updated);
    }
    return [...result.values()].join(';');
  }

  function propertyValue(key, value, page) {
    if (key === 'title' && page) return pageName(value);
    if (key === 'tine.type' && mapping.types[page]) return mapping.types[page];
    if (key === 'tine.fields' || /^tine\.(?:(?:page|block)-)?col-aggregates$/.test(key)) {
      return uniqueSegments(value, part => part.replace(/^(\s*)([^=;]+?)(\s*)=/,
        (_, lead, name, trail) => lead + fieldName(name) + trail + '='), part => part.split('=')[0].trim());
    }
    if (/^tine\.(?:(?:page|block)-)?columns$/.test(key)) {
      return uniqueSegments(value, part => part.replace(/\S+/, fieldName), part => part.trim());
    }
    if (/^tine\.(?:(?:page|block)-)?sort$/.test(key)) {
      return uniqueSegments(value, part => part.replace(/\S+/, fieldName), part => part.trim().split(/\s/)[0]);
    }
    if (/^tine\.(?:(?:page|block)-)?group-field$/.test(key) || key === 'tine.group-by') return fieldName(value);
    if (key === 'tine.table-widths') {
      return uniqueSegments(value, part => {
        const eq = part.indexOf('=');
        if (eq < 0) throw new Error('Invalid table width');
        const name = decodeURIComponent(part.slice(0, eq)), changed = fieldName(name);
        return (name === changed ? part.slice(0, eq) : encodeURIComponent(changed)) + part.slice(eq);
      }, part => decodeURIComponent(part.split('=')[0]));
    }
    // Formula/filter grammars are not plain property names. Require a deliberate
    // implementation before migrating a graph whose expressions use changed keys.
    if (key.startsWith('tine.formula.') || key === 'tine.filter') {
      const tokens = value.match(/[\p{L}\p{N}_.-]+/gu) ?? [];
      if (tokens.some(token => keyName(token) !== token)) throw new Error('Property merge needs a formula/filter migration for ' + key);
    }
    return references(value);
  }

  function properties(entries, page = null) {
    const seen = new Set();
    return entries.map(([key, value]) => {
      const renamed = keyName(key), identity = keyIdentity(renamed);
      if (seen.has(identity)) throw new Error('Two properties on one owner would merge into ' + renamed);
      seen.add(identity);
      return [renamed, propertyValue(key, value, page)];
    });
  }
  const macro = (name, value) => name === 'tine-query' ? expression(value)
    : name === 'query' ? ogExpression(value) : references(value);
  return {keyName, pageName, fieldName, references, expression, propertyValue, properties, macro};
}

export async function rewriteDocument({raw, page, mapping}) {
  const parse = await parser(), original = Buffer.from(raw), doc = parse(raw), patches = [];
  const rw = rewriter(mapping);
  function patch(span, after) {
    const before = original.subarray(...span).toString('utf8');
    if (before !== after) patches.push({start: span[0], end: span[1], after});
  }
  function inline(value) {
    if (!value || typeof value !== 'object' || value.k === 'code') return;
    if (value.k === 'link' && value.url?.type === 'page_ref') {
      patch(value.span, rw.references(original.subarray(...value.span).toString('utf8')));
      return;
    }
    if (value.k === 'macro') {
      patch(value.span, rw.macro(value.name, original.subarray(...value.span).toString('utf8')));
      return;
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(inline);
      else if (child && typeof child === 'object') inline(child);
    }
  }
  let header = true, ownerProperties = [];
  for (const block of doc.blocks) {
    if (block.kind === 'bullet' || block.kind === 'heading') {
      rw.properties(ownerProperties, header ? page : null);
      ownerProperties = [];
      header = false;
    }
    if (block.kind === 'properties') {
      ownerProperties.push(...block.props);
      const text = original.subarray(...block.span).toString('utf8');
      patch(block.span, text.replace(/(^[\t ]*)([^\s:]+)(::[\t ]*)([^\r\n]*)(\r?$)/gm,
        (_, indent, key, separator, value, ending) => indent + rw.keyName(key) + separator
          + rw.propertyValue(key, value, header ? page : null) + ending));
    } else inline(block);
  }
  rw.properties(ownerProperties, header ? page : null);
  patches.sort((a, b) => a.start - b.start);
  const pieces = [];
  let position = 0;
  for (const change of patches) {
    assert(change.start >= position, 'Overlapping syntax edits');
    pieces.push(original.subarray(position, change.start), Buffer.from(change.after));
    position = change.end;
  }
  pieces.push(original.subarray(position));
  const output = Buffer.concat(pieces).toString('utf8'), actual = parse(output);

  function expectedInline(value) {
    if (Array.isArray(value)) return value.map(expectedInline);
    if (!value || typeof value !== 'object' || value.k === 'code') return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expectedInline(child)]));
    if (value.k === 'link' && value.url?.type === 'page_ref') {
      result.url.v = rw.pageName(value.url.v);
      result.full = rw.references(value.full);
    }
    if (value.k === 'macro') result.args = value.args.map(arg => rw.macro(value.name, arg));
    return result;
  }
  const expected = stripSpans(doc);
  header = true;
  expected.blocks = expected.blocks.map(block => {
    if (block.kind === 'bullet' || block.kind === 'heading') header = false;
    return block.kind === 'properties' ? {...block, props: rw.properties(block.props, header ? page : null)} : expectedInline(block);
  });
  expected.refs.page = [...new Set(expected.refs.page.map(rw.pageName))];
  // Avoid printing private block contents if an invariant fails.
  const stripped = stripSpans(actual);
  if (!isDeepStrictEqual(stripped, expected)) {
    const difference = (a, b, location) => {
      if (isDeepStrictEqual(a, b)) return null;
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          const result = difference(a[key], b[key], location + '.' + key);
          if (result) return result;
        }
      }
      return location;
    };
    throw new Error('Unexpected parsed content change on page ' + page + ' at ' + difference(stripped, expected, 'document'));
  }
  return {raw: output, changes: patches.length};
}

export async function documentSummary(raw) {
  const parse = await parser(), doc = parse(raw);
  let bodyOffset = Buffer.byteLength(raw);
  const properties = [], blocks = [];
  for (const syntax of doc.blocks) {
    if (syntax.kind === 'bullet' || syntax.kind === 'heading') {
      if (!blocks.length) bodyOffset = syntax.span[0];
      blocks.push({level: syntax.level, properties: []});
    } else if (syntax.kind === 'properties') {
      (blocks.length ? blocks.at(-1).properties : properties).push(...syntax.props);
    }
  }
  return {properties, bodyOffset, blocks, ids: blocks.flatMap(block => block.properties.filter(([key]) => key === 'id').map(([, value]) => value))};
}
