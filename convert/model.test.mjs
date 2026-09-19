import test from 'node:test';
import assert from 'node:assert/strict';
import {Source, Names, isoDay, serializePage, Page, Block} from './tana_tine/model.mjs';
import {Converter, decimalNumber} from './tana_tine/converter.mjs';

const node = (id, name, owner, kind = 'node', children = []) => ({id, props: {name, _ownerId: owner, _docType: kind}, children});
const source = (workspace, additional = []) => new Source({[workspace]: {formatVersion: 1, docs: [
  node('root', 'Root', null), node('home', 'Workspace', 'root', 'home', additional.length ? ['field'] : []), ...additional,
]}});

test('decimal field values retain digits beyond JavaScript integer precision and scale', () => {
  const cases = [['9007199254740993', '9007199254740993'], ['+001.2300', '1.2300'], ['1.2300e2', '123.00'],
    ['.00500', '0.00500'], ['-0.00', '-0.00'], ['1e-8', '0.00000001'], ['42.', '42'], ['0e2', '0']];
  for (const [value, expected] of cases) assert.equal(decimalNumber(value), expected);
  for (const value of ['NaN', 'Infinity', '1e309', '12 MXN', '1,000', '']) assert.throws(() => decimalNumber(value), RangeError);
});

test('calendar validation rejects normalized invalid days and accepts Gregorian leap days', () => {
  assert.equal(isoDay('2000-02-29'), '2000-02-29');
  assert.equal(isoDay('2024-02-29'), '2024-02-29');
  assert.equal(isoDay('2024-02-29T12:00:00Z'), null);
  for (const value of ['1900-02-29', '2025-02-29', '2024-04-31', '2024-00-01', '0000-01-01']) assert.throws(() => isoDay(value), RangeError);
});

test('portable filename allocation disambiguates Unicode case folds and bounds UTF-8 size', () => {
  const names = new Names();
  const [first, firstPath] = names.allocate('Straße', 'first');
  const [second, secondPath] = names.allocate('STRASSE', 'second');
  assert.equal(first, 'Straße');
  assert.match(second, /^STRASSE · [a-f0-9]{8}$/);
  assert.notEqual(firstPath.toLowerCase(), secondPath.toLowerCase());
  const title = '書'.repeat(100);
  const [longTitle, longPath] = names.allocate(title, 'long');
  assert.equal(longTitle, title);
  assert.ok(Buffer.byteLength(longPath.split('/').at(-1)) <= 230);
});

test('workspace names and unknown source field types cannot resolve object prototype members', () => {
  const graph = new Converter(source('constructor', [node('field', 'constructor', 'home', 'attrDef', ['type']),
    node('type', '', 'field', 'tuple', ['SYS_T06', 'kind']), node('kind', 'constructor', 'type')])).finish();
  assert.equal(graph.pageFor.get('home').name, 'Workspace');
  assert.equal(graph.fields.get('field').query_type, 'text');
  assert.equal(graph.fields.get('field').declared_type, 'constructor');
});

test('missing names are empty but explicit non-text names fail', () => {
  const input = source('Example');
  input.nodes.get('home').props.name = null;
  assert.throws(() => input.name('home'), /not text/);
  delete input.nodes.get('home').props.name;
  assert.equal(input.name('home'), '');
});

test('a cyclic owner chain fails before conversion can lose a source subtree', () => {
  const input = source('Example', [node('field', 'Field', 'loop'), node('loop', 'Loop', 'field')]);
  assert.throws(() => new Converter(input).finish(), /Cyclic source ownership/);
});

test('serialized pages reject multiline metadata and over-deep outlines', () => {
  const page = new Page('Example', 'pages/Example.md', 'root', [], {'bad-key': 'first\nsecond'});
  assert.throws(() => serializePage(page), /single-line property/);
  page.properties = {};
  const root = new Block('root', 'Root');
  page.blocks.push(root);
  let current = root;
  for (let depth = 1; depth <= 128; depth++) {
    const child = new Block('block-' + depth, 'Child');
    current.children.push(child);
    current = child;
  }
  assert.throws(() => serializePage(page), /depth limit/);
});

test('large workspace outlines retain every sibling without argument-stack overflow', () => {
  const count = 140_000;
  const docs = [node('root', 'Root', null), node('home', 'Workspace', 'root', 'home',
    Array.from({length: count}, (_, index) => 'note-' + index))];
  for (let index = 0; index < count; index++) docs.push(node('note-' + index, 'Note', 'home'));
  const input = new Source({Example: {formatVersion: 1, docs}});
  assert.equal(input.archive('home').length, count + 1);
  const graph = new Converter(input).finish();
  const page = graph.pageFor.get('home');
  assert.equal(page.blocks.length, count + 1);
  const [, , records] = serializePage(page);
  assert.equal(records.length, count + 1);
  assert.equal(records[1].source_id, 'note-0');
  assert.equal(records.at(-1).source_id, 'note-' + (count - 1));
});
