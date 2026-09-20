/** Source-ID based, reproducible field/page decisions for a fresh import. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {encodePageName, pageIdentity, serializePage, unique, countBy} from './tana_tine/model.mjs';
import {RESERVED_KEYS, INTERNAL_KEYS} from './tana_tine/converter.mjs';
import {NativeScope} from './tana_tine/queries.mjs';
import {parser, rewriter} from './property-rewrite.mjs';
import {mapWorkers} from './workers.mjs';

export function decisionRewriter(mapping) {
  const rw = rewriter(mapping);
  const deletedKeys = new Set(mapping.deletedKeys);
  const deletedNames = mapping.deletedNames;
  const pageLabel = name => deletedNames[pageIdentity(name)] ?? rw.pageName(name);
  const references = value => value.replace(/\[\[([^\[\]\r\n]+)\]\]/g, (_, name) =>
    Object.hasOwn(deletedNames, pageIdentity(name)) ? pageLabel(name) : '[[' + rw.pageName(name) + ']]');
  function expression(value) {
    return value.replace(/\b(prop|tag|ref)\(\s*'((?:[^']|'')*)'\s*\)|\b(page\.name\s*(?:=|!=)\s*)'((?:[^']|'')*)'|'(?:[^']|'')*'|"(?:[^"]|"")*"/g,
      (all, call, argument, pagePrefix, pageArgument) => {
        if (!call && !pagePrefix) return all;
        const name = (argument ?? pageArgument).replaceAll("''", "'");
        if (call === 'prop' ? deletedKeys.has(name) : Object.hasOwn(deletedNames, pageIdentity(name))) {
          throw new Error('Live query depends on an excluded definition: ' + name);
        }
        const next = (call === 'prop' ? rw.keyName(name) : rw.pageName(name)).replaceAll("'", "''");
        return call ? call + "('" + next + "')" : pagePrefix + "'" + next + "'";
      });
  }
  function properties(input, page = null) {
    const result = {};
    for (const [key, original] of Object.entries(input)) {
      if (deletedKeys.has(key)) continue;
      let value = original;
      if (key === 'tine.fields') value = value.split(';').filter(part => !deletedKeys.has(part.split('=')[0].trim())).join(';');
      if (key === 'tine.columns') value = value.split(';').filter(part => !deletedKeys.has(part.trim())).join(';');
      if (key === 'tine.sort') value = value.split(';').filter(part => !deletedKeys.has(part.trim().split(/\s/)[0])).join(';');
      if (key === 'tine.group-field' && deletedKeys.has(value.replace(/^prop:/, ''))) continue;
      if ((key === 'tine.fields' || key === 'tine.columns' || key === 'tine.sort') && !value) continue;
      const renamed = rw.keyName(key);
      if (Object.hasOwn(result, renamed)) throw new Error('Conflicting properties on one owner: ' + renamed);
      result[renamed] = references(rw.propertyValue(key, value, page));
    }
    return result;
  }
  return {...rw, references, expression, properties, pageLabel};
}

function flatten(blocks) {
  return blocks.flatMap(block => [block, ...flatten(block.children)]);
}

/** Only parser-recognized inline constructs are rewritten; code stays literal. */
export async function rewriteDecisionPage({page, mapping}) {
  const parse = await parser(), rw = decisionRewriter(mapping);
  const [, original, expected] = serializePage(page), payload = Buffer.from(original);
  const doc = parse(original), changes = [];
  function patch(span, value) {
    const previous = payload.subarray(...span).toString('utf8');
    if (value !== previous) changes.push({start: span[0], end: span[1], value});
  }
  function inline(node) {
    if (!node || typeof node !== 'object' || node.k === 'code') return;
    if (node.k === 'tag') {
      const child = node.children[0], name = child?.text ?? child?.url?.v;
      if (typeof name !== 'string') throw new Error('Unrecognized imported tag');
      if (Object.hasOwn(mapping.deletedNames, pageIdentity(name))) patch(node.span, '');
      else if (rw.pageName(name) !== name) {
        const target = rw.pageName(name);
        patch(node.span, /^[\p{L}\p{N}_./-]+$/u.test(target) ? '#' + target : '#[[' + target + ']]');
      }
      return;
    }
    if (node.k === 'link' && node.url?.type === 'page_ref') {
      const raw = payload.subarray(...node.span).toString('utf8');
      patch(node.span, rw.references(raw));
      return;
    }
    if (node.k === 'link' && node.url?.type === 'block_ref' && mapping.deletedBlocks[node.url.v]) {
      patch(node.span, mapping.deletedBlocks[node.url.v]);
      return;
    }
    if (node.k === 'macro') {
      const raw = payload.subarray(...node.span).toString('utf8');
      patch(node.span, node.name === 'tine-query' ? rw.expression(raw) : node.name === 'query'
        ? rw.references(rw.macro(node.name, raw)) : rw.references(raw));
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inline);
      else if (value && typeof value === 'object') inline(value);
    }
  }
  for (const node of doc.blocks) if (node.kind !== 'properties') inline(node);
  changes.sort((a, b) => a.start - b.start);
  const parts = [];
  let offset = 0;
  for (const change of changes) {
    assert(change.start >= offset, 'Overlapping decision edits');
    parts.push(payload.subarray(offset, change.start), Buffer.from(change.value));
    offset = change.end;
  }
  parts.push(payload.subarray(offset));
  const output = Buffer.concat(parts), actual = parse(output.toString('utf8')), parsed = [];
  for (const node of actual.blocks) {
    if (node.kind === 'bullet' || node.kind === 'heading') parsed.push({node, propertySpans: [], properties: []});
    if (node.kind === 'properties' && parsed.length) {
      parsed.at(-1).propertySpans.push(node.span);
      parsed.at(-1).properties.push(...node.props);
    }
  }
  assert.equal(parsed.length, expected.length, 'Inline changes altered the block tree');
  const blocks = flatten(page.blocks);
  for (let index = 0; index < parsed.length; index++) {
    const block = parsed[index], previous = expected[index];
    assert.equal(block.node.level - 1, previous.depth, 'Inline changes altered block depth');
    assert.equal(block.properties.find(([key]) => key === 'id')?.[1], previous.uuid, 'Inline changes altered an ID');
    assert(isDeepStrictEqual(Object.fromEntries(block.properties), previous.properties), 'Inline changes altered properties');
    const segments = [];
    let position = block.node.span[0];
    for (const [start, end] of block.propertySpans) {
      segments.push(output.subarray(position, start));
      position = end;
    }
    segments.push(output.subarray(position, parsed[index + 1]?.node.span[0] ?? output.length));
    const lines = Buffer.concat(segments).toString('utf8').split('\n');
    const prefix = '\t'.repeat(previous.depth);
    assert(lines[0].startsWith(prefix + '- '));
    lines[0] = lines[0].slice(prefix.length + 2);
    for (let line = 1; line < lines.length - 1; line++) {
      assert(lines[line].startsWith(prefix + '  '));
      lines[line] = lines[line].slice(prefix.length + 2);
    }
    blocks[index].text = lines.join('\n').replace(/\n$/, '');
  }
  return {page, changed_spans: changes.length};
}

export async function applyImportDecisions(graph, decisions, jobs) {
  const mapping = {keys: {}, names: {}, types: {}, deletedKeys: [], deletedNames: {}, deletedBlocks: {}};
  const excludedFields = new Set(decisions.exclude_fields ?? []), excludedSources = new Set();
  const deletedPages = new Set(), consumed = new Set(), targets = [], fieldGroups = decisions.fields ?? [];
  const pageFor = identity => {
    const page = graph.pageFor.get(identity);
    if (!page) throw new Error('Decision does not identify an imported page: ' + identity);
    return page;
  };
  for (const identity of excludedFields) {
    if (!graph.fields.has(identity)) throw new Error('Unknown excluded field: ' + identity);
    mapping.deletedKeys.push(graph.fields.get(identity).key);
    deletedPages.add(pageFor(identity));
  }
  for (const identity of decisions.exclude_pages ?? []) deletedPages.add(pageFor(identity));
  for (const page of deletedPages) {
    consumed.add(page);
    const label = page.sourceIds.length ? graph.plain(page.sourceIds[0]) : page.name;
    mapping.deletedNames[pageIdentity(page.name)] = label;
    for (const id of page.sourceIds) excludedSources.add(id);
    for (const block of flatten(page.blocks)) {
      mapping.deletedBlocks[block.uuid] = label;
      if (block.sourceId) excludedSources.add(block.sourceId);
    }
  }
  function groupPages(sourceIds, name) {
    if (!Array.isArray(sourceIds) || !sourceIds.length || typeof name !== 'string' || !name.trim()) throw new Error('Invalid page decision');
    const pages = unique(sourceIds.map(pageFor));
    for (const page of pages) {
      if (consumed.has(page)) throw new Error('Page belongs to overlapping decisions: ' + page.name);
      consumed.add(page);
      mapping.names[pageIdentity(page.name)] = name;
    }
    targets.push({pages, name});
  }
  for (const group of fieldGroups) {
    if (!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(group.key) || RESERVED_KEYS.has(group.key)
      || INTERNAL_KEYS.has(group.key) || /^(?:tine|logseq)[.-]/.test(group.key)) throw new Error('Invalid decided property key: ' + group.key);
    if (!/^(list of )?(text|number|date|checkbox|ref)$/.test(group.query_type)) throw new Error('Invalid decided query type: ' + group.query_type);
    for (const identity of group.sources) {
      const field = graph.fields.get(identity);
      if (!field) throw new Error('Unknown field in decision: ' + identity);
      mapping.keys[field.key] = group.key;
      mapping.types[field.page] = group.query_type;
    }
    groupPages(group.sources, group.key);
  }
  for (const group of decisions.pages ?? []) groupPages(group.sources, group.name);
  const finalPages = [...graph.pages.values()].filter(page => !consumed.has(page));
  const names = new Set(finalPages.map(page => pageIdentity(page.name)));
  const filenames = new Set(finalPages.map(page => page.path.toLowerCase()));
  for (const target of targets) {
    const name = pageIdentity(target.name), filename = 'pages/' + encodePageName(target.name) + '.md';
    if (names.has(name) || filenames.has(filename.toLowerCase())) throw new Error('Decided page name collides: ' + target.name);
    names.add(name);
    filenames.add(filename.toLowerCase());
  }
  const rw = decisionRewriter(mapping);
  const beforeBlocks = [...graph.pages.values()].flatMap(page => flatten(page.blocks));
  const removedIds = new Set(Object.keys(mapping.deletedBlocks));
  for (const page of graph.pages.values()) {
    page.properties = rw.properties(page.properties, page.name);
    for (const block of flatten(page.blocks)) block.properties = rw.properties(block.properties);
  }
  // Keep one graph-wide declaration; source-specific sheet menus remain local.
  for (const group of fieldGroups) for (const identity of group.sources) {
    Object.assign(graph.fields.get(identity), {key: group.key, page: group.key, query_type: group.query_type,
      many: group.query_type.startsWith('list of ')});
  }
  const destination = new Map(), mergedTags = new Map();
  for (const target of targets) {
    const page = target.pages[0], properties = {};
    for (const member of target.pages) for (const [key, value] of Object.entries(member.properties)) {
      if (Object.hasOwn(properties, key) && properties[key] !== value) throw new Error('Merged pages have conflicting ' + key + ': ' + target.name);
      properties[key] = value;
    }
    const tagIds = target.pages.flatMap(page => page.sourceIds).filter(id => graph.tags.has(id));
    for (const identity of tagIds) mergedTags.set(identity, tagIds[0]);
    const blocks = target.pages.flatMap(page => page.blocks), sourceIds = unique(target.pages.flatMap(page => page.sourceIds));
    for (const member of target.pages) destination.set(member, page);
    Object.assign(page, {name: target.name, path: 'pages/' + encodePageName(target.name) + '.md', properties, blocks, sourceIds});
    finalPages.push(page);
  }
  for (const [identity, page] of graph.pages) {
    if (deletedPages.has(page) || (destination.has(page) && destination.get(page) !== page)) graph.pages.delete(identity);
  }
  for (const [identity, page] of graph.pageFor) {
    if (deletedPages.has(page)) graph.pageFor.delete(identity);
    else if (destination.has(page)) graph.pageFor.set(identity, destination.get(page));
  }
  for (const [identity, reference] of graph.refs) {
    if (excludedSources.has(identity)) graph.refs.delete(identity);
    else if (reference.type === 'page') reference.target = rw.pageName(reference.target);
  }
  for (const identity of excludedSources) {
    graph.required.delete(identity);
    graph.emitted.delete(identity);
    graph.tags.delete(identity);
  }
  for (const identity of excludedFields) graph.fields.delete(identity);
  for (const [identity, canonical] of mergedTags) if (identity !== canonical) graph.tags.delete(identity);
  for (const [uuid, tags] of graph.nativeTags) graph.nativeTags.set(uuid, unique(tags.filter(id => !excludedSources.has(id)).map(id => mergedTags.get(id) ?? id)));
  const entries = [...graph.pages], rewritten = await mapWorkers('rewriteDecisionPage', entries.map(([, page]) => ({page, mapping})), jobs);
  entries.forEach(([, page], index) => Object.assign(page, rewritten[index].page));
  for (const query of graph.queries) {
    if (query.expression) query.expression = rw.expression(query.expression);
    if (query.view_properties) query.view_properties = rw.properties(query.view_properties);
  }
  for (const scalar of graph.scalarIds.values()) scalar.property = rw.keyName(scalar.property);
  for (const record of graph.representations.values()) if (record.property) record.property = rw.keyName(record.property);
  const calendarCleanup = graph.pruneCalendarMetadata();
  for (const identity of calendarCleanup.removed_block_ids) removedIds.add(identity);
  // Check the widened facet identities as well as the original conservative bounds.
  const scope = new NativeScope(graph);
  function rewriteScope(value) {
    if (!value) return value;
    const [kind, term] = value;
    if (kind === 'property') return [kind, rw.keyName(term)];
    if (kind === 'tag') return [kind, mergedTags.get(term) ?? term];
    if (kind === 'ref') return [kind, rw.pageName(term)];
    return kind === 'and' || kind === 'or' ? [kind, term.map(rewriteScope)] : value;
  }
  for (const [query, , candidates] of graph.nativeQueries) {
    if (query.status === 'translated') query.scope_validation = scope.validate(rewriteScope(candidates));
  }
  graph.validateIds();
  const afterBlocks = [...graph.pages.values()].flatMap(page => flatten(page.blocks));
  assert.deepEqual(afterBlocks.map(block => block.uuid).sort(), beforeBlocks.filter(block => !removedIds.has(block.uuid)).map(block => block.uuid).sort(), 'Unapproved block removal');
  const audit = {plan: decisions, removed_source_ids: [...excludedSources], removed_block_ids: [...removedIds],
    calendar_cleanup: calendarCleanup,
    field_merge_groups: fieldGroups.filter(group => group.sources.length > 1).length,
    page_merge_groups: (decisions.pages ?? []).filter(group => group.sources.length > 1).length,
    removed_pages: deletedPages.size, blocks_before: beforeBlocks.length, blocks_after: afterBlocks.length,
    changed_spans: rewritten.reduce((total, item) => total + item.changed_spans, 0)};
  graph.importDecisions = audit;
  return audit;
}

export function recordImportDecisions(manifest, graph) {
  if (!graph.importDecisions) return;
  manifest.import_decisions = graph.importDecisions;
  for (const identity of graph.importDecisions.removed_source_ids) {
    manifest.nodes[identity] = {...graph.sourceProvenance(identity), status: 'excluded-by-decision'};
  }
  manifest.counts.node_statuses = countBy(Object.values(manifest.nodes).map(node => node.status));
  manifest.counts.unique_properties = new Set(Object.values(manifest.fields).map(field => field.key)).size;
}
