import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {run, parseArgs} from './tana-to-tine.mjs';

async function fixture(t, depth = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tana-node-cli-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const input = path.join(root, 'Workspace.json');
  const docs = [
    {id: 'root', props: {name: 'Root', _docType: 'workspace'}, children: []},
    {id: 'home', props: {name: 'Workspace', _docType: 'home', _ownerId: 'root'}, children: ['note-0']},
  ];
  for (let index = 0; index < depth; index++) docs.push({id: 'note-' + index,
    props: {name: 'Note ' + index, _ownerId: index ? 'note-' + (index - 1) : 'home'},
    children: index + 1 < depth ? ['note-' + (index + 1)] : []});
  await fs.writeFile(input, JSON.stringify({formatVersion: 1, docs}));
  const args = (output, extra = []) => parseArgs(['--input', input, '--output', output, '--jobs', '2', '--skip-assets', ...extra]);
  return {root, input, args};
}
const quiet = {log() {}};

test('worker counts preserve page bytes, identities and source files', async t => {
  const {root, input, args} = await fixture(t, 5);
  const source = await fs.readFile(input);
  const first = path.join(root, 'one');
  const second = path.join(root, 'two');
  await run({...args(first), jobs: 1}, quiet);
  await run(args(second), quiet);
  const before = JSON.parse(await fs.readFile(path.join(first, 'import-manifest.json')));
  const after = JSON.parse(await fs.readFile(path.join(second, 'import-manifest.json')));
  assert.deepEqual(before.pages, after.pages);
  assert.deepEqual(before.expected_blocks, after.expected_blocks);
  for (const page of before.pages) assert.deepEqual(await fs.readFile(path.join(first, page.path)), await fs.readFile(path.join(second, page.path)));
  assert.deepEqual(await fs.readFile(input), source);
  assert.deepEqual(await fs.readFile(path.join(first, 'assets/tana-source/exports/Workspace.json')), source);
});

test('overwrite keeps edited generated graphs in a sibling backup', async t => {
  const {root, args} = await fixture(t);
  const output = path.join(root, 'graph');
  await run(args(output), quiet);
  const edited = path.join(output, 'pages/handwritten.md');
  await fs.writeFile(edited, '- User-authored content\n');
  await assert.rejects(run(args(output), quiet), /Output is nonempty/);
  assert.equal(await fs.readFile(edited, 'utf8'), '- User-authored content\n');
  await run(args(output, ['--overwrite']), quiet);
  const backups = (await fs.readdir(root)).filter(name => name.startsWith('graph.previous-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(root, backups[0], 'pages/handwritten.md'), 'utf8'), '- User-authored content\n');
  await assert.rejects(fs.stat(edited), {code: 'ENOENT'});
  assert.ok((await fs.readdir(output)).includes('import-manifest.json'));
});

test('an output containing an input and an unrelated nonempty output are refused before staging', async t => {
  const {root, args} = await fixture(t);
  await assert.rejects(run(args(root, ['--overwrite']), quiet), /must not contain/);
  const output = path.join(root, 'unrelated');
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'keep.txt'), 'Existing data');
  await assert.rejects(run(args(output, ['--overwrite']), quiet), /requires an existing/);
  assert.equal(await fs.readFile(path.join(output, 'keep.txt'), 'utf8'), 'Existing data');
  assert.equal((await fs.readdir(root)).filter(name => name.startsWith('.tana-to-tine-')).length, 0);
});

test('a serialization failure leaves the previous graph intact and the staging evidence separate', async t => {
  const {root, input, args} = await fixture(t);
  const output = path.join(root, 'graph');
  await run(args(output), quiet);
  const originalManifest = await fs.readFile(path.join(output, 'import-manifest.json'));
  const deep = await fixture(t, 130);
  await fs.copyFile(deep.input, input);
  await assert.rejects(run(args(output, ['--overwrite']), quiet), /depth limit/);
  assert.deepEqual(await fs.readFile(path.join(output, 'import-manifest.json')), originalManifest);
  assert.equal((await fs.readdir(root)).filter(name => name.startsWith('.tana-to-tine-')).length, 1);
  assert.equal((await fs.readdir(root)).filter(name => name.startsWith('graph.previous-')).length, 0);
});
