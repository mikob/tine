import test from 'node:test';
import assert from 'node:assert/strict';
import {Source, Names, isoDay, calendarAnchor, serializePage, encodePageName, pageNameFromPath, Page, Block} from './tana_tine/model.mjs';
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

test('period anchors use Sunday-start weeks, including ISO year boundaries and leap years', () => {
  for (const [period, day] of [['2025-W17','2025-04-20'], ['2020-W01','2019-12-29'], ['2020-W53','2020-12-27'],
    ['2021-W01','2021-01-03'], ['2024-W09','2024-02-25'], ['2025-09','2025-09-01'], ['2025','2025-01-01'], ['2024-02-29','2024-02-29']]) {
    assert.equal(calendarAnchor(period), day);
  }
  for (const period of ['2021-W53', '2025-W00', '2025-W54', '2025-13', '0000', '2025-02-29']) assert.throws(() => calendarAnchor(period), RangeError);
  assert.equal(calendarAnchor('Week 17'), null);
});

test('inline days and range endpoints become journals without timezone JSON', () => {
  const graph = new Converter(source('Example'));
  assert.equal(graph.dateReference({dateTimeString: '2025-11-21', timezone: 'America/Mexico_City'}), '[[Nov 21st, 2025]]');
  assert.equal(graph.dateReference({dateTimeString: '2025-11-26/2025-11-28', timezone: 'America/Mexico_City'}),
    '[[Nov 26th, 2025]] – [[Nov 28th, 2025]]');
  assert.deepEqual([...graph.pages.values()].filter(page => page.kind === 'journal').map(page => page.path),
    ['journals/2025_11_21.md', 'journals/2025_11_26.md', 'journals/2025_11_28.md']);
  assert.equal(graph.dateReference({dateTimeString: '2025-11-21', timezone: 'America/Mexico_City'}, true), '2025-11-21');
});

test('inline periods retain their labels while linking to native daily anchors', () => {
  const graph = new Converter(source('Example'));
  assert.equal(graph.dateReference({dateTimeString:'2025-W17',timezone:'America/Mexico_City'}),'[2025-W17]([[Apr 20th, 2025]])');
  assert.equal(graph.dateReference({dateTimeString:'2025-09'}),'[2025-09]([[Sep 1st, 2025]])');
  assert.equal(graph.dateReference({dateTimeString:'2025'}),'[2025]([[Jan 1st, 2025]])');
  assert.equal(graph.dateReference({dateTimeString:'2025-W17'},true),'2025-W17');
  assert.throws(()=>graph.dateReference({dateTimeString:'2021-W53'}),RangeError);
});

test('timed references preserve clock precision, offsets and zones on both endpoints', () => {
  const graph = new Converter(source('Example'));
  assert.equal(graph.dateReference({dateTimeString: '2025-06-12T19:00:00.000/2025-06-13T00:15:00.123', timezone: 'America/Mexico_City', hasTime: true}),
    '[[Jun 12th, 2025]] 19:00:00.000 – [[Jun 13th, 2025]] 00:15:00.123 (America/Mexico_City)');
  assert.equal(graph.dateReference({dateTimeString: '2025-06-12T23:30-06:00'}), '[[Jun 12th, 2025]] 23:30-06:00');
  assert.equal(graph.dateReference({dateTimeString: '2025-06-12T00:15Z'}), '[[Jun 12th, 2025]] 00:15Z');
  assert.equal(graph.dateReference({dateTimeString: 'Invalid DateTime', timezone: 'UTC'}), 'Invalid DateTime ({"timezone": "UTC"})');
  assert.equal(graph.dateReference({dateTimeString: '2025-06-12', extra: 'retain'}), '[[Jun 12th, 2025]] ({"extra": "retain"})');
  assert.throws(() => graph.dateReference({dateTimeString: '2025-02-29'}), RangeError);
});

test('page headers omit redundant titles but preserve filename overrides', () => {
  for (const name of ['Project/Roadmap', 'a___b', 'CON.txt', 'Café', '50% progress']) {
    const filename = 'pages/' + encodePageName(name) + '.md';
    assert.equal(pageNameFromPath(filename), name);
    const [, content] = serializePage(new Page(name, filename, 'root', [], {}, [new Block('id', 'Note')]));
    assert.ok(content.startsWith('- Note\n'));
  }
  assert.equal(pageNameFromPath('journals/2025_11_21.md'), 'Nov 21st, 2025');
  assert.equal(pageNameFromPath('pages/2025-02-29.md'), '2025-02-29');
  assert.equal(pageNameFromPath('pages/%xx%25.md'), '%xx%');
  assert.equal(serializePage(new Page('Nov 21st, 2025', 'journals/2025_11_21.md', 'journal'))[1], '\n');
  assert.match(serializePage(new Page('Long name', 'pages/page-hash.md', 'root'))[1], /^title:: Long name\n/);
  assert.match(serializePage(new Page('Filename', 'pages/Filename.md', 'root', [], {title: 'Authored override'}))[1], /^title:: Authored override\n/);
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
