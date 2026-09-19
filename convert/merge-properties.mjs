#!/usr/bin/env node
/** Merge explicitly equivalent Tana fields in an edited graph, without reimporting it. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {RESERVED_KEYS, INTERNAL_KEYS} from './tana_tine/converter.mjs';
import {encodePageName, pageIdentity, sha256, isoDay} from './tana_tine/model.mjs';
import {availableWorkers, mapConcurrent, mapWorkers} from './workers.mjs';
import {documentSummary, parser, rewriter, stripSpans} from './property-rewrite.mjs';

const readJson = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const writeJson = async (filename, data) => fs.writeFile(filename, JSON.stringify(data, null, 2) + '\n');
const exists = async filename => { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

export function mergeMapping(manifest, plan) {
  if (!Array.isArray(plan.groups) || !plan.groups.length) throw new Error('Plan needs nonempty groups');
  const keys = {}, names = {}, types = {}, paths = {}, groups = [];
  const ids = new Set(), targets = new Set();
  for (const group of plan.groups) {
    const {key, query_type: type, fields} = group;
    if (typeof key !== 'string' || !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(key)
      || RESERVED_KEYS.has(key) || INTERNAL_KEYS.has(key) || /^(?:tine|logseq)[.-]/.test(key)) throw new Error('Unsafe or reserved merged key: ' + key);
    if (!/^(list of )?(text|number|date|checkbox|ref)$/.test(type)) throw new Error('Invalid query type for ' + key);
    if (targets.has(key)) throw new Error('Repeated merge target: ' + key);
    targets.add(key);
    if (!Array.isArray(fields) || fields.length < 2) throw new Error('A merge requires at least two source field IDs');
    const pages = [];
    for (const id of fields) {
      if (ids.has(id)) throw new Error('Source field occurs in multiple merges: ' + id);
      ids.add(id);
      const field = manifest.fields[id];
      if (!field) throw new Error('Unknown source field: ' + id);
      keys[field.key] = key;
      names[pageIdentity(field.page)] = key;
      types[field.page] = type;
      const page = manifest.working_graph?.property_pages?.[field.page]
        ?? manifest.pages.find(page => page.name === field.page);
      if (!page) throw new Error('Missing property page: ' + field.page);
      if (!pages.includes(page.path)) pages.push(page.path);
      paths[page.path] = 'pages/' + encodePageName(key) + '.md';
    }
    const targetPath = 'pages/' + encodePageName(key) + '.md';
    pages.sort((a, b) => (a === targetPath ? -1 : b === targetPath ? 1 : a.localeCompare(b)));
    groups.push({...group, pages, path: targetPath});
  }
  for (const [id, field] of Object.entries(manifest.fields)) {
    if (!ids.has(id) && (targets.has(field.key) || Object.hasOwn(keys, field.key))) throw new Error('Merge omits another source field sharing key ' + field.key);
  }
  return {keys, names, types, paths, groups};
}

async function markdownFiles(root) {
  const paths = [];
  async function visit(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), {withFileTypes: true})) {
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Linked page files are not supported: ' + child);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && /\.(?:md|markdown)$/i.test(entry.name)) paths.push(child);
      else if (/\.org$/i.test(entry.name)) throw new Error('Property merging currently requires Markdown pages');
    }
  }
  for (const directory of ['pages', 'journals']) if (await exists(path.join(root, directory))) await visit(directory);
  return paths.sort();
}

function validateValues(summary, mapping, location) {
  for (const owner of [summary, ...summary.blocks]) {
    for (const [key, value] of owner.properties) {
      const group = mapping.groups.find(group => group.key === key);
      if (!group || !value.trim()) continue;
      const type = group.query_type;
      let valid = true;
      if (type === 'number') valid = /^[+-]?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
      if (type === 'date') valid = !!isoDay(value);
      if (type === 'checkbox') valid = value === 'true' || value === 'false';
      if (!valid) throw new Error('Value does not fit merged type ' + type + ' for ' + key + ' in ' + location);
    }
  }
}

export async function stageMerges(graph, plan, stage, jobs = availableWorkers()) {
  graph = path.resolve(graph);
  stage = path.resolve(stage);
  const relativeStage = path.relative(graph, stage);
  if (!relativeStage || (!relativeStage.startsWith('..' + path.sep) && relativeStage !== '..' && !path.isAbsolute(relativeStage))) throw new Error('Stage must be outside the graph');
  if (await exists(stage)) throw new Error('Stage already exists: ' + stage);
  const originalManifest = await fs.readFile(path.join(graph, 'import-manifest.json'));
  const manifest = JSON.parse(originalManifest);
  if (manifest.converter !== 'tana-to-tine') throw new Error('Expected a tana-to-tine import manifest');
  const mapping = mergeMapping(manifest, plan), rw = rewriter(mapping);
  const files = await markdownFiles(graph), fileSet = new Set(files);
  for (const group of mapping.groups) {
    for (const file of group.pages) if (!fileSet.has(file)) throw new Error('Missing definition page: ' + file);
    if (fileSet.has(group.path) && !group.pages.includes(group.path)) throw new Error('Target page is already occupied: ' + group.path);
  }
  const config = await fs.readFile(path.join(graph, 'logseq/config.edn'), 'utf8');
  if (!/:pages-directory\s+"pages"/.test(config) || !/:journals-directory\s+"journals"/.test(config)
    || !/:file\/name-format\s+:triple-lowbar/.test(config)) throw new Error('Unsupported graph directory or filename configuration');
  const backup = stage + '.before';
  if (await exists(backup)) throw new Error('Backup already exists: ' + backup);
  await fs.mkdir(stage, {recursive: true});
  await fs.mkdir(backup);
  const snapshots = await mapConcurrent(files, jobs, async file => {
    const raw = await fs.readFile(path.join(graph, file), 'utf8');
    await fs.mkdir(path.dirname(path.join(backup, file)), {recursive: true});
    await fs.writeFile(path.join(backup, file), raw, {flag: 'wx'});
    const page = raw.match(/^title::\s*(.*)$/m)?.[1]?.trim();
    if (!page) throw new Error('Page has no explicit title: ' + file);
    return {path: file, page, sha256: sha256(raw), raw};
  });
  const ancillary = {};
  for (const file of ['import-manifest.json', 'conversion-report.json', 'logseq/config.edn', 'assets.json']) {
    const payload = await fs.readFile(path.join(graph, file));
    ancillary[file] = sha256(payload);
    await fs.mkdir(path.dirname(path.join(backup, file)), {recursive: true});
    await fs.copyFile(path.join(graph, file), path.join(backup, file));
  }
  assert.equal(ancillary['import-manifest.json'], sha256(originalManifest), 'Manifest changed while staging');
  const rewritten = await mapWorkers('rewriteProperties', snapshots.map(file => ({raw: file.raw, page: file.page, mapping})), jobs);
  const outputs = new Map(snapshots.map((file, i) => [file.path, rewritten[i].raw]));
  const parse = await parser();
  for (const group of mapping.groups) {
    const summaries = await Promise.all(group.pages.map(file => documentSummary(outputs.get(file))));
    const headers = new Map(), bodies = [], expectedBlocks = [];
    for (let index = 0; index < group.pages.length; index++) {
      const file = group.pages[index], raw = outputs.get(file), summary = summaries[index];
      for (const [key, value] of summary.properties) {
        if (headers.has(key) && headers.get(key) !== value) throw new Error('Definition pages have conflicting metadata for ' + group.key + ': ' + key);
        headers.set(key, value);
      }
      bodies.push(Buffer.from(raw).subarray(summary.bodyOffset).toString('utf8'));
      const ast = parse(raw);
      const first = ast.blocks.findIndex(block => block.kind === 'bullet' || block.kind === 'heading');
      if (first >= 0) expectedBlocks.push(...stripSpans(ast.blocks.slice(first)));
      outputs.delete(file);
    }
    assert.equal(headers.get('title'), group.key);
    assert.equal(headers.get('tine.type'), group.query_type);
    const raw = [...headers].map(([key, value]) => key + '::' + (value ? ' ' + value : '')).join('\n') + '\n\n'
      + bodies.map(body => body.endsWith('\n') || !body ? body : body + '\n').join('');
    const actual = parse(raw), first = actual.blocks.findIndex(block => block.kind === 'bullet' || block.kind === 'heading');
    assert.deepEqual(stripSpans(first < 0 ? [] : actual.blocks.slice(first)), expectedBlocks, 'Definition block trees changed');
    outputs.set(group.path, raw);
  }
  const beforeIds = [], afterIds = [], afterFiles = {}, propertyPages = {};
  let beforeBlocks = 0, afterBlocks = 0;
  for (const file of snapshots) {
    const summary = await documentSummary(file.raw);
    beforeIds.push(...summary.ids);
    beforeBlocks += summary.blocks.length;
  }
  for (const [file, raw] of outputs) {
    const summary = await documentSummary(raw);
    validateValues(summary, mapping, file);
    afterIds.push(...summary.ids);
    afterBlocks += summary.blocks.length;
    afterFiles[file] = {sha256: sha256(raw), blocks: summary.blocks.length,
      user_edited_since_import: manifest.working_graph?.files?.[file]?.user_edited_since_import
        || snapshots.find(snapshot => snapshot.path === file)?.sha256 !== manifest.pages.find(page => page.path === file)?.sha256};
    const header = Object.fromEntries(summary.properties);
    if (header['tine.type']) propertyPages[header.title] = {name: header.title, path: file, properties: header};
    await fs.mkdir(path.dirname(path.join(stage, file)), {recursive: true});
    await fs.writeFile(path.join(stage, file), raw, {flag: 'wx'});
  }
  assert.equal(beforeBlocks, afterBlocks, 'Block count changed');
  assert.equal(new Set(beforeIds).size, beforeIds.length, 'Baseline has duplicate persistent IDs');
  assert.deepEqual(beforeIds.sort(), afterIds.sort(), 'Persistent block identities changed');
  const priorFields = {};
  for (const group of mapping.groups) for (const id of group.fields) {
    priorFields[id] = structuredClone(manifest.fields[id]);
    // Local sheet types/options stay scoped to their original schemas. A global
    // declaration does not rewrite a text cell or broaden an enum.
    Object.assign(manifest.fields[id], {key: group.key, page: group.key, query_type: group.query_type,
      many: group.query_type.startsWith('list of ')});
  }
  for (const node of Object.values(manifest.nodes)) {
    if (node.property) node.property = rw.keyName(node.property);
    if (node.page) node.page = rw.pageName(node.page);
    if (node.path) node.path = mapping.paths[node.path] ?? node.path;
    for (const name of ['reference', 'target']) if (node[name]?.type === 'page') node[name].target = rw.pageName(node[name].target);
  }
  for (const query of manifest.queries) {
    if (query.expression) query.expression = rw.expression(query.expression);
    if (query.view_properties) query.view_properties = Object.fromEntries(rw.properties(Object.entries(query.view_properties)));
  }
  const audit = {groups: mapping.groups, previous_fields: priorFields, backup,
    previous_manifest_sha256: sha256(originalManifest)};
  manifest.property_merges = [...(manifest.property_merges ?? []), audit];
  manifest.working_graph = {
    scope: 'pages, expected_blocks, and counts retain the pre-merge conversion baseline. fields, nodes, queries, property_pages, and files describe current mappings. Later user edits are preserved; do not regenerate this graph from the baseline.',
    pages: outputs.size, blocks: afterBlocks, persisted_ids: afterIds.length, files: afterFiles, property_pages: propertyPages,
  };
  const report = {ok: true, graph, stage, backup, jobs, groups: mapping.groups,
    parser: 'Bundled Tine lsdoc WASM; before/after AST checks for every document and consolidated definition tree',
    pages_before: files.length, pages_after: outputs.size, blocks: afterBlocks, persisted_ids: afterIds.length,
    previous_files: Object.fromEntries(snapshots.map(file => [file.path, file.sha256])),
    files: Object.fromEntries(Object.entries(afterFiles).map(([file, info]) => [file, info.sha256])),
    ancillary, changed_files: [...outputs].filter(([file, raw]) => !snapshots.some(snapshot => snapshot.path === file && snapshot.raw === raw)).map(([file]) => file),
    removed_files: files.filter(file => !outputs.has(file)),
  };
  await fs.mkdir(path.join(stage, 'logseq'));
  await fs.writeFile(path.join(stage, 'logseq/config.edn'), config);
  await fs.copyFile(path.join(backup, 'assets.json'), path.join(stage, 'assets.json'));
  await fs.symlink(path.join(graph, 'assets'), path.join(stage, 'assets'), 'dir');
  await writeJson(path.join(stage, 'import-manifest.json'), manifest);
  const conversion = await readJson(path.join(backup, 'conversion-report.json'));
  conversion.working_graph = {pages: outputs.size, blocks: afterBlocks, property_merges: mapping.groups.length};
  await writeJson(path.join(stage, 'conversion-report.json'), conversion);
  report.manifest_sha256 = sha256(await fs.readFile(path.join(stage, 'import-manifest.json')));
  report.conversion_report_sha256 = sha256(await fs.readFile(path.join(stage, 'conversion-report.json')));
  await writeJson(path.join(stage, 'property-merge-validation.json'), report);
  return report;
}

/** Refuse any intervening edit; retain the complete Markdown/metadata snapshot. */
export async function publishMerges(stage) {
  stage = path.resolve(stage);
  const report = await readJson(path.join(stage, 'property-merge-validation.json'));
  assert.equal(report.stage, stage);
  assert.equal(report.ok, true);
  const graph = report.graph;
  assert.deepEqual(await markdownFiles(graph), Object.keys(report.previous_files).sort(), 'Graph file set changed while reviewing merge');
  assert.deepEqual(await markdownFiles(stage), Object.keys(report.files).sort(), 'Stage file set changed');
  for (const [file, expected] of Object.entries({...report.previous_files, ...report.ancillary})) {
    assert.equal(sha256(await fs.readFile(path.join(graph, file))), expected, 'Graph changed while reviewing merge: ' + file);
    assert.equal(sha256(await fs.readFile(path.join(report.backup, file))), expected, 'Backup mismatch: ' + file);
  }
  const targets = {...report.files, 'import-manifest.json': report.manifest_sha256,
    'conversion-report.json': report.conversion_report_sha256};
  for (const [file, expected] of Object.entries(targets)) assert.equal(sha256(await fs.readFile(path.join(stage, file))), expected, 'Stage changed: ' + file);
  assert.equal(sha256(await fs.readFile(path.join(stage, 'logseq/config.edn'))), report.ancillary['logseq/config.edn']);
  assert.equal(sha256(await fs.readFile(path.join(stage, 'assets.json'))), report.ancillary['assets.json']);
  const writes = [...report.changed_files, 'import-manifest.json', 'conversion-report.json'];
  for (const file of writes) {
    const destination = path.join(graph, file), expected = report.previous_files[file] ?? report.ancillary[file];
    if (expected) assert.equal(sha256(await fs.readFile(destination)), expected, 'Concurrent edit: ' + file);
    else assert.equal(await exists(destination), false, 'New destination appeared: ' + file);
    const temporary = destination + '.property-merge-' + process.pid;
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.copyFile(path.join(stage, file), temporary, fs.constants.COPYFILE_EXCL);
    // Recheck after preparing the write, so an edit cannot slip through staging.
    if (expected) assert.equal(sha256(await fs.readFile(destination)), expected, 'Concurrent edit: ' + file);
    else assert.equal(await exists(destination), false, 'New destination appeared: ' + file);
    await fs.rename(temporary, destination);
  }
  for (const file of report.removed_files) {
    assert.equal(sha256(await fs.readFile(path.join(graph, file))), report.previous_files[file], 'Concurrent edit: ' + file);
    await fs.unlink(path.join(graph, file));
  }
  await fs.copyFile(path.join(stage, 'property-merge-validation.json'), path.join(graph, 'property-merge-validation.json'));
  for (const [file, expected] of Object.entries(targets)) assert.equal(sha256(await fs.readFile(path.join(graph, file))), expected, 'Published file mismatch: ' + file);
  return {applied: true, graph, backup: report.backup, groups: report.groups.length,
    property_keys_removed: report.pages_before - report.pages_after, blocks: report.blocks, persisted_ids: report.persisted_ids};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const {values, positionals} = parseArgs({allowPositionals: true, options: {
      plan: {type: 'string'}, stage: {type: 'string'}, publish: {type: 'string'},
      jobs: {type: 'string', default: String(availableWorkers())}, help: {type: 'boolean'},
    }});
    if (values.help) console.log('Stage: node merge-properties.mjs GRAPH --plan PLAN.json --stage STAGE [--jobs N]\nApply a checked stage: node merge-properties.mjs --publish STAGE');
    else if (values.publish) console.log(JSON.stringify(await publishMerges(values.publish), null, 2));
    else {
      if (positionals.length !== 1 || !values.plan || !values.stage) throw new Error('Require GRAPH --plan PLAN.json --stage STAGE');
      const result = await stageMerges(positionals[0], await readJson(values.plan), values.stage, Number(values.jobs));
      console.log(JSON.stringify({stage: result.stage, backup: result.backup, groups: result.groups.length,
        pages_before: result.pages_before, pages_after: result.pages_after, blocks: result.blocks, persisted_ids: result.persisted_ids}, null, 2));
    }
  } catch (error) {
    console.error('Error: ' + error.message);
    process.exitCode = 1;
  }
}
