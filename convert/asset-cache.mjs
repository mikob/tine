/** Collect attachments, reuse verified bytes, and download with bounded concurrency. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { decodeHTML } from 'entities';
import { availableWorkers, mapConcurrent, mapWorkers, validateJobs } from './workers.mjs';

export { availableWorkers };

const ATTACHMENT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.heic', '.pdf', '.mp3',
  '.mp4', '.m4a', '.wav', '.ogg', '.mov', '.webm', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx', '.zip', '.epub',
]);
const MIME_EXTENSIONS = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/heic': '.heic', 'image/tiff': '.tiff',
  'application/pdf': '.pdf', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4', 'audio/mp4': '.m4a',
  'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'video/ogg': '.ogv',
  'video/quicktime': '.mov', 'video/webm': '.webm', 'audio/webm': '.weba',
  'application/msword': '.doc', 'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt', 'application/zip': '.zip',
  'application/epub+zip': '.epub', 'application/octet-stream': '.bin',
  'application/json': '.json', 'text/plain': '.txt', 'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};
const remoteSource = source => /^https?:\/\//.test(source);
const sortedObject = entries => Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

function unquote(value) {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, encoded => Buffer.from(encoded.replaceAll('%', ''), 'hex').toString('utf8'));
}

function sourcePath(source) {
  return remoteSource(source) ? new URL(source).pathname : source.split(/[?#]/, 1)[0];
}

function cleanUrl(value) {
  value = decodeHTML(value).trim().replace(/[.,;]+$/, '');
  for (const [closing, opening] of [['}', '{'], [')', '('], [']', '[']]) {
    while (value.endsWith(closing) && value.split(closing).length > value.split(opening).length) value = value.slice(0, -1);
  }
  return value;
}

function* strings(value) {
  if (typeof value === 'string') yield value;
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) yield* strings(item);
  }
}

export async function discoverExport(filename) {
  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (data.formatVersion !== 1 || !Array.isArray(data.docs)) throw new Error(`Not a Tana formatVersion 1 export: ${filename}`);
  const nodes = new Map(data.docs.map(node => [node.id, node]));
  const activeCache = new Map();
  function active(identity) {
    const seen = new Set();
    let current = identity;
    let included = false;
    while (nodes.has(current)) {
      if (seen.has(current)) throw new Error(`Cyclic Tana ownership at ${current}`);
      seen.add(current);
      if (current.endsWith('_TRASH')) { included = false; break; }
      if (activeCache.has(current)) { included ||= activeCache.get(current); break; }
      const props = nodes.get(current).props;
      if (props._docType === 'home' || /_(?:STASH|SCHEMA|SEARCHES|CAPTURE_INBOX)$/.test(current)) included = true;
      current = props._ownerId;
    }
    activeCache.set(identity, included);
    return included;
  }
  const found = new Set();
  for (const [identity, node] of nodes) {
    if (identity.startsWith('SYS_') || !active(identity)) continue;
    const props = node.props;
    const metadata = nodes.get(props._metaNodeId);
    for (const tupleId of metadata?.children ?? []) {
      const children = nodes.get(tupleId)?.children ?? [];
      if (children[0] === 'SYS_T15') {
        for (const child of children.slice(1)) {
          const value = cleanUrl(nodes.get(child)?.props?.name ?? '');
          if (remoteSource(value)) found.add(value);
        }
      }
    }
    for (const raw of strings(props)) {
      const text = decodeHTML(raw);
      for (const match of text.matchAll(/https?:\/\/[^\s"<>]+/g)) {
        const value = cleanUrl(match[0]);
        const parsed = new URL(value);
        if (parsed.hostname === 'firebasestorage.googleapis.com' || ATTACHMENT_EXTENSIONS.has(path.extname(unquote(parsed.pathname)).toLowerCase())) found.add(value);
      }
      for (const match of text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
        if (remoteSource(match[1])) found.add(cleanUrl(match[1]));
      }
      for (const match of text.matchAll(/(?<![\p{L}\p{N}_/])(?:\.\.\/|\.\/)?assets\/[^\s<>"\)\]]+/gu)) {
        if (/^\.[A-Za-z0-9]{1,12}$/.test(path.extname(unquote(sourcePath(match[0]))))) found.add(match[0]);
      }
    }
  }
  return [...found].sort();
}

export async function discoverSources(sourcePaths, jobs = availableWorkers()) {
  if (!sourcePaths.length) throw new Error('No source exports supplied');
  const groups = await mapWorkers('discoverExport', sourcePaths.map(String), jobs);
  return [...new Set(groups.flat())].sort();
}

export async function digest(filename) {
  const checksum = createHash('sha256');
  let size = 0;
  for await (const payload of createReadStream(filename)) { checksum.update(payload); size += payload.length; }
  return [checksum.digest('hex'), size];
}

function extension(source, contentType) {
  const suffix = path.extname(unquote(sourcePath(source))).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(suffix) ? suffix : (MIME_EXTENSIONS[contentType] ?? '.bin');
}

export async function statIfExists(filename) {
  try { return await fs.stat(filename); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}

// Resolve existing symlink ancestors even when the final file does not exist.
export async function resolvePath(filename) {
  let current = path.resolve(filename);
  const missing = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing.reverse()); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function inside(root, filename) {
  const [resolvedRoot, resolved] = await Promise.all([resolvePath(root), resolvePath(filename)]);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Attachment path escapes its cache directory: ${filename}`);
  return resolved;
}

async function cacheEntries(cacheDirs) {
  const entries = new Map();
  for (const root of cacheDirs) {
    if (!(await statIfExists(root))?.isDirectory()) throw new Error(`Asset cache directory does not exist: ${root}`);
    const manifest = path.join(root, 'assets.json');
    if (!await statIfExists(manifest)) continue;
    let data = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (data && !Array.isArray(data) && typeof data === 'object') data = Object.entries(data).map(([source, item]) => ({ ...item, source }));
    if (!Array.isArray(data)) throw new Error(`Asset manifest must be an array or a source-keyed object: ${manifest}`);
    for (const item of data) {
      const source = item.source || item.url;
      if (!source) throw new Error(`Asset manifest entry has no source/url: ${manifest}`);
      const record = { ...item, cacheRoot: root };
      if (item.path) record.cachePath = await inside(root, path.resolve(root, item.path));
      else if (item.file) record.cachePath = await inside(root, path.resolve(root, 'assets', item.file));
      if (!entries.has(source)) entries.set(source, []);
      entries.get(source).push(record);
    }
  }
  return entries;
}

export async function copyLocal(source, filename, directory, expected) {
  const [checksum, size] = await digest(filename);
  if (expected && expected !== checksum) return [null, 'Cached file failed its SHA-256 check'];
  if (!size) return [null, 'Cached file is empty'];
  const destination = path.join(directory, checksum + extension(path.basename(filename)));
  if (!await statIfExists(destination)) {
    const temporary = path.join(directory, `.asset-${randomUUID()}.tmp`);
    try {
      await fs.copyFile(filename, temporary, fs.constants.COPYFILE_EXCL);
      const [copiedChecksum] = await digest(temporary);
      if (copiedChecksum !== checksum) throw new Error(`Cached attachment changed while copying: ${filename}`);
      await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
  } else {
    const [existingChecksum] = await digest(destination);
    if (existingChecksum !== checksum) throw new Error(`Destination attachment failed its SHA-256 check: ${destination}`);
  }
  return [{ source, status: 'copied', path: `assets/${path.basename(destination)}`, sha256: checksum, size }, null];
}

class NetworkFailure extends Error {}

const isSystemError = error => typeof error.code === 'string' && /^E[A-Z0-9]+$/.test(error.code);

async function networkOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name) || isSystemError(error)) {
      throw new NetworkFailure(error.message, { cause: error });
    }
    throw error;
  }
}

async function* responseChunks(body) {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await networkOperation(() => reader.read());
      if (done) break;
      yield value;
    }
  } finally {
    try { await networkOperation(() => reader.cancel()); }
    finally { reader.releaseLock(); }
  }
}

async function errorBody(response) {
  if (!response.body) return '';
  const chunks = [];
  let size = 0;
  for await (const value of responseChunks(response.body)) {
    const chunk = Buffer.from(value).subarray(0, 2048 - size);
    chunks.push(chunk); size += chunk.length;
    if (size >= 2048) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function downloadOne(source, directory, { fetcher = fetch } = {}) {
  let temporary;
  let handle;
  try {
    const response = await networkOperation(() => fetcher(source, {
      headers: { 'User-Agent': 'Tana-to-Tine/1.0' }, signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) {
      const body = await errorBody(response);
      let reason = `HTTP ${response.status}`;
      if (body.includes('Blocked by') || body.includes('network policy')) reason += `: ${body.trim()}`;
      return { source, status: 'unavailable', reason };
    }
    const contentType = (response.headers.get('content-type') ?? 'text/plain').split(';', 1)[0].trim().toLowerCase();
    if (['text/html', 'application/xhtml+xml'].includes(contentType)) {
      if (response.body) await networkOperation(() => response.body.cancel());
      return { source, status: 'unavailable', reason: 'Attachment returned an HTML page' };
    }
    temporary = path.join(directory, `.asset-${randomUUID()}.tmp`);
    handle = await fs.open(temporary, 'wx', 0o600);
    const checksum = createHash('sha256');
    let size = 0;
    let prefix = Buffer.alloc(0);
    let sniffed = false;
    const isHtml = () => /^(?:<!doctype html|<html)/i.test(prefix.toString('latin1').replace(/^[\t\n\v\f\r ]+/, '').slice(0, 100));
    if (response.body) {
      for await (const raw of responseChunks(response.body)) {
        const payload = Buffer.from(raw);
        if (!sniffed) {
          prefix = Buffer.concat([prefix, payload.subarray(0, 1024 * 1024 - prefix.length)]);
          if (isHtml()) return { source, status: 'unavailable', reason: 'Attachment body is HTML' };
          sniffed = prefix.length >= 1024 * 1024 || prefix.toString('latin1').replace(/^[\t\n\v\f\r ]+/, '').length >= 14;
        }
        await handle.writeFile(payload);
        checksum.update(payload); size += payload.length;
      }
    }
    if (!size) return { source, status: 'unavailable', reason: 'Attachment response was empty' };
    const sha256 = checksum.digest('hex');
    const destination = path.join(directory, sha256 + extension(source, contentType));
    await handle.close(); handle = undefined;
    await fs.rename(temporary, destination); temporary = undefined;
    return { source, status: 'downloaded', path: `assets/${path.basename(destination)}`, sha256, size, content_type: contentType };
  } catch (error) {
    if (error instanceof NetworkFailure || isSystemError(error)) {
      return { source, status: 'unavailable', reason: error.message };
    }
    throw error;
  } finally {
    if (handle) await handle.close();
    if (temporary) await fs.rm(temporary, { force: true });
  }
}

export async function buildAssetMap(sourcePaths, outputDir, jobs = availableWorkers(), { cacheDirs = [], download = true, progress } = {}) {
  validateJobs(jobs);
  sourcePaths = sourcePaths.map(filename => path.resolve(filename));
  cacheDirs = cacheDirs.map(directory => path.resolve(directory));
  const sources = await discoverSources(sourcePaths, jobs);
  const directory = path.join(outputDir, 'assets');
  await fs.mkdir(directory, { recursive: true });
  const caches = await cacheEntries(cacheDirs);
  const relativeRoots = [...cacheDirs, ...[...new Set(sourcePaths.map(filename => path.dirname(filename)))].sort()];
  let completed = 0;
  const entries = await mapConcurrent(sources, jobs, async source => {
    const notes = [];
    let result;
    for (const record of caches.get(source) ?? []) {
      if (record.cachePath && (await statIfExists(record.cachePath))?.isFile()) {
        const [copied, issue] = await copyLocal(source, record.cachePath, directory, record.sha256 || record.checksum);
        if (copied) { result = copied; break; }
        notes.push(issue);
      } else if (record.reason) notes.push(record.reason);
    }
    if (!result && !remoteSource(source)) {
      const relative = source.replace(/^\.\.\//, '').replace(/^\.\//, '');
      for (const root of relativeRoots) {
        const filename = await inside(root, path.resolve(root, unquote(relative)));
        if ((await statIfExists(filename))?.isFile()) {
          const [copied, issue] = await copyLocal(source, filename, directory);
          if (copied) { result = copied; break; }
          notes.push(issue);
        }
      }
      result ??= { source, status: 'unavailable', reason: 'Relative attachment bytes are not in the supplied exports or caches' };
    } else if (!result) {
      result = download ? await downloadOne(source, directory) : { source, status: 'unavailable', reason: 'No verified cached file; downloads disabled' };
    }
    if (notes.length && result.status !== 'copied') result.cache_notes = [...new Set(notes)];
    completed++;
    progress?.(completed, sources.length);
    return [source, result];
  });
  return sortedObject(entries);
}

export async function refreshAssetMap(graphDir, records, jobs = availableWorkers(), { retryDownloads = false } = {}) {
  validateJobs(jobs);
  const root = await resolvePath(graphDir);
  if (!(await statIfExists(root))?.isDirectory() || !records || Array.isArray(records) || typeof records !== 'object') throw new Error('Expected a graph directory and a source-keyed asset manifest');
  const entries = await mapConcurrent(Object.entries(records), jobs, async ([source, record]) => {
    if (record.source !== source) throw new Error(`Asset manifest source does not match its key: ${source}`);
    const remote = remoteSource(source);
    const candidates = [];
    if (record.path) candidates.push([await inside(root, path.resolve(root, record.path)), record.sha256]);
    if (!remote) {
      const relative = unquote(source.replace(/^\.\.\//, '').replace(/^\.\//, ''));
      if (!relative.startsWith('assets/')) throw new Error(`Local attachment is not an assets path: ${source}`);
      candidates.push([await inside(root, path.resolve(root, relative)), null]);
    }
    for (const [filename, expected] of candidates) {
      if (!(await statIfExists(filename))?.isFile()) continue;
      const [sha256, size] = await digest(filename);
      if (expected && sha256 !== expected) throw new Error(`Recorded attachment failed its SHA-256 check: ${filename}`);
      if (!size) continue;
      return [source, { source, status: ['copied', 'downloaded', 'available'].includes(record.status) ? record.status : 'available',
        path: path.relative(root, filename).split(path.sep).join('/'), sha256, size }];
    }
    if (remote && retryDownloads) {
      await fs.mkdir(path.join(root, 'assets'), { recursive: true });
      return [source, await downloadOne(source, path.join(root, 'assets'))];
    }
    if (record.status === 'unavailable') return [source, record];
    return [source, { source, status: 'unavailable', reason: 'Recorded attachment file is missing or empty' }];
  });
  return sortedObject(entries);
}
