import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CONFIG} from './tana-to-tine.mjs';
import {stageMerges, publishMerges, mergeMapping} from './merge-properties.mjs';
import {rewriteDocument, documentSummary, rewriter} from './property-rewrite.mjs';

const mapping = {
  keys: {price: 'price', 'price-other': 'price'},
  names: {price: 'price', 'price-other': 'price'}, types: {price: 'text', 'price-other': 'text'},
};
const plan = {groups: [{key: 'price', query_type: 'text', fields: ['first', 'second']}]};

test('rewrite actual keys, references, query calls and view identities, preserving code and values', async () => {
  const raw = [
    'title:: Records', '',
    '- {{tine-query @block and prop(\'price-other\') is not null}}',
    '  price-other:: $25 per hour',
    '  tine.fields:: price-other=text',
    '  tine.columns:: price-other',
    '  tine.sort:: price-other desc',
    '  tine.group-field:: prop:price-other',
    '  tine.table-widths:: prop%3Aprice-other=180',
    '  tine.col-aggregates:: price-other=count',
    '  tine.block-columns:: price-other',
    '- [price label]([[price-other]])',
    '- Both [[price]] and [[price-other]]',
    '- Literal price-other and ' + String.fromCharCode(96) + '[[price-other]]' + String.fromCharCode(96),
    '- ' + String.fromCharCode(96).repeat(3),
    '  price-other:: not a property',
    '  [[price-other]]',
    '  ' + String.fromCharCode(96).repeat(3), '',
  ].join('\n');
  const {raw: actual} = await rewriteDocument({raw, page: 'Records', mapping});
  assert.match(actual, /prop\('price'\)/);
  assert.match(actual, /price:: \$25 per hour/);
  assert.match(actual, /tine.fields:: price=text/);
  assert.match(actual, /tine.table-widths:: prop%3Aprice=180/);
  assert.match(actual, /tine.block-columns:: price/);
  assert.match(actual, /\[price label\]\(\[\[price\]\]\)/);
  assert.ok(actual.includes('Literal price-other and ' + String.fromCharCode(96) + '[[price-other]]' + String.fromCharCode(96)));
  assert.ok(actual.includes('price-other:: not a property\n  [[price-other]]'));
  const rw = rewriter(mapping);
  assert.equal(rw.expression('@block and title = "prop(\'price-other\')"'), '@block and title = "prop(\'price-other\')"');
  assert.equal(rw.macro('query', '(property price-other "$25")'), '(property price "$25")');
});

test('conflicting values, schemas, widths and formula references fail without dropping anything', async () => {
  await assert.rejects(rewriteDocument({raw: '- A\n  price:: one\n  price-other:: two\n', page: 'A', mapping}), /Two properties/);
  for (const line of [
    'tine.fields:: price=number;price-other=text',
    'tine.table-widths:: prop%3Aprice=100;prop%3Aprice-other=200',
    'tine.formula.total:: price-other * 2',
  ]) await assert.rejects(rewriteDocument({raw: '- A\n  ' + line + '\n', page: 'A', mapping}), /Conflicting|formula/);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tine-property-merge-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const graph = path.join(directory, 'graph'), stage = path.join(directory, 'stage');
  await fs.mkdir(path.join(graph, 'pages'), {recursive: true});
  await fs.mkdir(path.join(graph, 'logseq'));
  await fs.mkdir(path.join(graph, 'assets'));
  const docs = {
    price: 'tine.type:: text\n\n- Price definition\n  id:: 00000000-0000-4000-8000-000000000001\n',
    'price-other': 'title:: price-other\ntine.type:: number\n\n- Other definition\n  id:: 00000000-0000-4000-8000-000000000002\n',
    Records: '- Current edited record\n  id:: 00000000-0000-4000-8000-000000000003\n  price-other:: 12.30\n- Untouched record\n  id:: 00000000-0000-4000-8000-000000000004\n  price:: $4 / kg\n',
  };
  const pages = Object.entries(docs).map(([name]) => ({name, path: 'pages/' + name + '.md'}));
  const manifest = {converter: 'tana-to-tine', fields: {
    first: {key: 'price', page: 'price', query_type: 'text', sheet_type: 'text'},
    second: {key: 'price-other', page: 'price-other', query_type: 'number', sheet_type: 'number'},
  }, nodes: {value: {property: 'price-other'}}, queries: [], pages, expected_blocks: [], counts: {pages: 3}};
  for (const [name, raw] of Object.entries(docs)) await fs.writeFile(path.join(graph, 'pages', name + '.md'), raw);
  for (const [name, value] of Object.entries({'import-manifest.json': manifest, 'conversion-report.json': {}, 'assets.json': {}})) {
    await fs.writeFile(path.join(graph, name), JSON.stringify(value));
  }
  await fs.writeFile(path.join(graph, 'logseq/config.edn'), CONFIG);
  await fs.writeFile(path.join(graph, 'assets/example.txt'), 'asset bytes');
  return {directory, graph, stage, manifest, docs};
}

test('stage/publish merges edited files, definition trees and provenance without reimporting', async t => {
  const {graph, stage, docs} = await fixture(t);
  const result = await stageMerges(graph, plan, stage, 2);
  assert.equal(result.pages_after, 2);
  assert.equal(result.persisted_ids, 4);
  assert.equal(await fs.readFile(path.join(graph, 'pages/Records.md'), 'utf8'), docs.Records);
  const merged = await fs.readFile(path.join(stage, 'pages/price.md'), 'utf8');
  assert.equal((await documentSummary(merged)).ids.length, 2);
  assert.ok(merged.includes('Other definition'));
  await publishMerges(stage);
  const current = await fs.readFile(path.join(graph, 'pages/Records.md'), 'utf8');
  assert.ok(current.includes('Current edited record'));
  assert.ok(current.includes('price:: 12.30'));
  assert.ok(current.includes('price:: $4 / kg'));
  assert.equal(await fs.readFile(path.join(graph, 'assets/example.txt'), 'utf8'), 'asset bytes');
  await assert.rejects(fs.stat(path.join(graph, 'pages/price-other.md')), {code: 'ENOENT'});
  const manifest = JSON.parse(await fs.readFile(path.join(graph, 'import-manifest.json')));
  assert.equal(manifest.fields.second.key, 'price');
  assert.equal(manifest.nodes.value.property, 'price');
  assert.equal(manifest.fields.second.sheet_type, 'number');
  assert.equal(manifest.property_merges[0].previous_fields.second.query_type, 'number');
  assert.equal(await fs.readFile(path.join(result.backup, 'pages/Records.md'), 'utf8'), docs.Records);
  const repeated = await stageMerges(graph, plan, stage + '-again', 2);
  assert.equal(repeated.pages_after, 2);
  assert.equal(repeated.changed_files.length, 0);
});

test('intervening edits refuse publication and remain untouched', async t => {
  const {graph, stage} = await fixture(t);
  await stageMerges(graph, plan, stage, 1);
  const file = path.join(graph, 'pages/Records.md');
  await fs.appendFile(file, '- New user edit\n');
  await assert.rejects(publishMerges(stage), /Graph changed/);
  assert.ok((await fs.readFile(file, 'utf8')).endsWith('- New user edit\n'));
  await fs.stat(path.join(graph, 'pages/price-other.md'));
});

test('reject undeclared participant, reserved key, occupied page and invalid numeric values', async t => {
  const {manifest, graph, stage} = await fixture(t);
  assert.throws(() => mergeMapping(manifest, {groups: [{...plan.groups[0], key: 'priority'}]}), /reserved/);
  assert.throws(() => mergeMapping(manifest, {groups: [{...plan.groups[0], fields: ['first', 'absent']}]}), /Unknown/);
  assert.throws(() => mergeMapping({...manifest, fields: {...manifest.fields, third: {key: 'price', page: 'price'}}}, plan), /omits/);
  await assert.rejects(stageMerges(graph, {groups: [{...plan.groups[0], query_type: 'number'}]}, stage, 1), /does not fit/);
});
