import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAssetMap, copyLocal, discoverExport, discoverSources, downloadOne, inside, refreshAssetMap } from './asset-cache.mjs';
import { atomicJson, refreshGraph } from './refresh-assets.mjs';
import { mapWorkers } from './workers.mjs';
import { parseArgs, parseFieldNames } from './tana-to-tine.mjs';

const sha256 = payload => createHash('sha256').update(payload).digest('hex');
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'tine-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeExport(root) {
  const filename = path.join(root, 'Workspace.json');
  const docs = [
    { id: 'home', props: { _docType: 'home', name: 'Workspace' } },
    { id: 'note', props: { _ownerId: 'home', _metaNodeId: 'meta', name: '![image](https://example.test/photo.png) and ../assets/local.png' } },
    { id: 'meta', props: { _ownerId: 'note' }, children: ['tuple'] },
    { id: 'tuple', props: { _ownerId: 'meta', _docType: 'tuple' }, children: ['SYS_T15', 'url'] },
    { id: 'url', props: { _ownerId: 'tuple', name: 'https://example.test/opaque' } },
    { id: 'space_TRASH', props: { name: 'Trash' } },
    { id: 'discarded', props: { _ownerId: 'space_TRASH', name: 'https://example.test/trash.png' } },
  ];
  await fs.writeFile(filename, JSON.stringify({ formatVersion: 1, docs }));
  return filename;
}

test('discovers metadata and relative files while excluding trash', async t => {
  const root = await temporary(t);
  const filename = await writeExport(root);
  const expected = ['../assets/local.png', 'https://example.test/opaque', 'https://example.test/photo.png'];
  assert.deepEqual(await discoverExport(filename), expected);
  assert.deepEqual(await discoverSources([filename, filename], 2), expected);
});

test('verified caches and relative assets retain exact bytes', async t => {
  const root = await temporary(t);
  const filename = await writeExport(root);
  const cache = path.join(root, 'cache');
  await fs.mkdir(path.join(cache, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(cache, 'assets/photo.png'), 'photo data');
  await fs.writeFile(path.join(root, 'assets/local.png'), 'local data');
  await fs.writeFile(path.join(cache, 'assets.json'), JSON.stringify([{ url: 'https://example.test/photo.png', status: 'downloaded',
    file: 'photo.png', checksum: sha256('photo data') }]));
  const output = path.join(root, 'output');
  const progress = [];
  const result = await buildAssetMap([filename], output, 2, { cacheDirs: [cache], download: false, progress: (...args) => progress.push(args) });
  assert.equal(result['https://example.test/photo.png'].status, 'copied');
  assert.equal(await fs.readFile(path.join(output, result['https://example.test/photo.png'].path), 'utf8'), 'photo data');
  assert.equal(result['../assets/local.png'].status, 'copied');
  assert.equal(result['https://example.test/opaque'].status, 'unavailable');
  assert.equal(await fs.readFile(path.join(cache, 'assets/photo.png'), 'utf8'), 'photo data');
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  const repeated = await buildAssetMap([filename], path.join(root, 'second'), 1, { cacheDirs: [cache], download: false });
  assert.deepEqual(repeated, result);
});

test('source-keyed cache manifests and checksum failures are handled explicitly', async t => {
  const root = await temporary(t);
  const filename = await writeExport(root);
  const cache = path.join(root, 'cache');
  await fs.mkdir(path.join(cache, 'assets'), { recursive: true });
  await fs.writeFile(path.join(cache, 'assets/photo.png'), 'corrupted');
  const url = 'https://example.test/photo.png';
  await fs.writeFile(path.join(cache, 'assets.json'), JSON.stringify({ [url]: {
    source: url, status: 'copied', path: 'assets/photo.png', sha256: '0'.repeat(64),
  } }));
  const output = path.join(root, 'output');
  const result = await buildAssetMap([filename], output, 2, { cacheDirs: [cache], download: false });
  assert.equal(result[url].status, 'unavailable');
  assert.match(result[url].cache_notes[0], /SHA-256/);
  assert.deepEqual(await fs.readdir(path.join(output, 'assets')), []);
});

test('mismatched local caches are never copied', async t => {
  const root = await temporary(t);
  const filename = path.join(root, 'bad.png');
  const output = path.join(root, 'output');
  await fs.writeFile(filename, 'corrupted');
  await fs.mkdir(output);
  const [result, reason] = await copyLocal('https://example.test/p.png', filename, output, '0'.repeat(64));
  assert.equal(result, null);
  assert.match(reason, /SHA-256/);
  assert.deepEqual(await fs.readdir(output), []);
});

test('cache containment rejects traversal and symlink escapes', async t => {
  const root = await temporary(t);
  const cache = path.join(root, 'cache');
  const outside = path.join(root, 'outside');
  await fs.mkdir(cache);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(cache, 'assets'), 'dir');
  await assert.rejects(inside(cache, path.join(cache, '../outside.png')), /escapes/);
  await assert.rejects(inside(cache, path.join(cache, 'assets/missing.png')), /escapes/);
});

test('HTML, mislabeled HTML, and empty downloads leave no files', async t => {
  const root = await temporary(t);
  for (const [contentType, payload] of [['text/html', '<html>Login</html>'], ['image/png', ''],
    ['image/png', '<!doctype html><html>Sign in</html>']]) {
    const result = await downloadOne('https://example.test/photo.png', root, {
      fetcher: async () => new Response(payload, { headers: { 'Content-Type': contentType } }),
    });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(await fs.readdir(root), []);
  }
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('  <ht'));
    controller.enqueue(Buffer.from('ml>Login</html>'));
    controller.close();
  } });
  const result = await downloadOne('https://example.test/photo.png', root, {
    fetcher: async () => new Response(stream, { headers: { 'Content-Type': 'image/png' } }),
  });
  assert.equal(result.reason, 'Attachment body is HTML');
  assert.deepEqual(await fs.readdir(root), []);
});

test('downloads record exact bytes and hashes and preserve HTTP failure reasons', async t => {
  const root = await temporary(t);
  const result = await downloadOne('https://example.test/opaque', root, {
    fetcher: async () => new Response('image bytes', { headers: { 'Content-Type': 'image/png' } }),
  });
  assert.equal(result.status, 'downloaded');
  assert.equal(result.sha256, sha256('image bytes'));
  assert.equal(result.content_type, 'image/png');
  assert.equal(await fs.readFile(path.join(root, path.basename(result.path)), 'utf8'), 'image bytes');
  const audio = await downloadOne('https://example.test/audio', root, {
    fetcher: async () => new Response('audio bytes', { headers: { 'Content-Type': 'audio/ogg' } }),
  });
  assert.equal(path.extname(audio.path), '.ogg');
  const failure = await downloadOne('https://example.test/photo.png', root, {
    fetcher: async () => new Response('Blocked by network policy', { status: 403 }),
  });
  assert.equal(failure.reason, 'HTTP 403: Blocked by network policy');
});

test('network failures leave no files while programmer errors reject', async t => {
  const root = await temporary(t);
  const source = 'https://example.test/photo.png';
  const failedFetch = await downloadOne(source, root, {
    fetcher: async () => { throw new TypeError('fetch failed'); },
  });
  assert.deepEqual(failedFetch, { source, status: 'unavailable', reason: 'fetch failed' });
  const interrupted = new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('partial attachment'));
    controller.error(new TypeError('connection closed'));
  } });
  const failedStream = await downloadOne(source, root, {
    fetcher: async () => new Response(interrupted, { headers: { 'Content-Type': 'image/png' } }),
  });
  assert.equal(failedStream.reason, 'connection closed');
  await assert.rejects(downloadOne(source, root, {
    fetcher: async () => ({ ok: true, headers: null }),
  }), TypeError);
  const invalidChunks = new ReadableStream({ start(controller) {
    controller.enqueue({ invalid: 'attachment bytes' });
    controller.close();
  } });
  await assert.rejects(downloadOne(source, root, {
    fetcher: async () => new Response(invalidChunks, { headers: { 'Content-Type': 'image/png' } }),
  }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('refresh finds supplied files without copying or renaming them', async t => {
  const root = await temporary(t);
  const directory = path.join(root, 'assets');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'original name.png'), 'added image');
  await fs.writeFile(path.join(directory, 'unrelated.bin'), 'preserve me');
  const source = '../assets/original%20name.png';
  const record = { source, status: 'unavailable', reason: 'not supplied' };
  const result = await refreshAssetMap(root, { [source]: record }, 2);
  assert.deepEqual(result[source], { source, status: 'available', path: 'assets/original name.png', sha256: sha256('added image'), size: 11 });
  assert.deepEqual((await fs.readdir(directory)).sort(), ['original name.png', 'unrelated.bin']);
  assert.equal(await fs.readFile(path.join(directory, 'unrelated.bin'), 'utf8'), 'preserve me');
  assert.deepEqual(await refreshAssetMap(root, result, 2), result);
});

test('refresh rejects changed recorded bytes and paths escaping the graph', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets/a.png'), 'changed');
  const source = 'https://example.test/a.png';
  await assert.rejects(refreshAssetMap(root, { [source]: { source, status: 'copied', path: 'assets/a.png', sha256: '0'.repeat(64) } }, 1), /SHA-256/);
  const escaping = '../assets/../../outside.png';
  await assert.rejects(refreshAssetMap(root, { [escaping]: { source: escaping, status: 'unavailable' } }, 1), /escapes/);
});

test('refresh never guesses remote files from matching basenames', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets/a.png'), 'unrelated');
  const source = 'https://example.test/a.png';
  const records = { [source]: { source, status: 'unavailable', reason: 'HTTP 404' } };
  assert.deepEqual(await refreshAssetMap(root, records, 1), records);
});

test('graph refresh updates all three audit files and retains file permissions', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets/a.png'), 'image');
  const source = '../assets/a.png';
  const records = { [source]: { source, status: 'unavailable', reason: 'not supplied' } };
  await atomicJson(path.join(root, 'assets.json'), records);
  await fs.chmod(path.join(root, 'assets.json'), 0o640);
  await atomicJson(path.join(root, 'import-manifest.json'), { converter: 'tana-to-tine', assets: records, retained: 'metadata' });
  await atomicJson(path.join(root, 'conversion-report.json'), { asset_statuses: { unavailable: 1 }, retained: 'report' });
  const result = await refreshGraph(root, 2);
  assert.equal(result.newly_available, 1);
  assert.deepEqual(result.asset_statuses, { available: 1 });
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'import-manifest.json'), 'utf8'));
  const assets = JSON.parse(await fs.readFile(path.join(root, 'assets.json'), 'utf8'));
  const report = JSON.parse(await fs.readFile(path.join(root, 'conversion-report.json'), 'utf8'));
  assert.deepEqual(manifest.assets, assets);
  assert.equal(manifest.retained, 'metadata');
  assert.equal(report.retained, 'report');
  assert.deepEqual(report.asset_statuses, { available: 1 });
  assert.equal((await fs.stat(path.join(root, 'assets.json'))).mode & 0o777, 0o640);
  await fs.chmod(path.join(root, 'assets.json'), 0);
  await atomicJson(path.join(root, 'assets.json'), assets);
  assert.equal((await fs.stat(path.join(root, 'assets.json'))).mode & 0o777, 0);
});

test('worker errors reject promptly without leaving background workers', async () => {
  await assert.rejects(mapWorkers('unknown-task', ['sample'], 1), /Unknown worker task/);
  await assert.rejects(discoverSources([], 1), /No source exports/);
  await assert.rejects(mapWorkers('discoverExport', [], 0), /positive integer/);
});

test('CLI parsing rejects duplicate field overrides and invalid worker counts', () => {
  assert.deepEqual(parseFieldNames(['rating=score']), { rating: 'score' });
  assert.throws(() => parseFieldNames(['rating=score', 'rating=other']), /Duplicate/);
  assert.throws(() => parseFieldNames(['rating']), /SOURCE_FIELD_ID=KEY/);
  assert.throws(() => parseArgs(['--input', 'example.json', '--output', 'graph', '--jobs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--input', 'example.json']), /required/);
  assert.equal(parseArgs(['--help']).help, true);
});
