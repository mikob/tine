#!/usr/bin/env node
/** Recheck a converted graph's assets in place, retaining existing filenames. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { availableWorkers, refreshAssetMap, resolvePath, statIfExists } from './asset-cache.mjs';
import { validateJobs } from './workers.mjs';

export async function atomicJson(filename, value) {
  const previous = await statIfExists(filename);
  const mode = previous ? previous.mode & 0o7777 : 0o644;
  const temporary = path.join(path.dirname(filename), `.json-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(mode);
    await handle.close(); handle = undefined;
    await fs.rename(temporary, filename);
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, { force: true });
  }
}

export async function refreshGraph(graphDir, jobs = availableWorkers(), { retryDownloads = false } = {}) {
  const root = await resolvePath(graphDir);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'import-manifest.json'), 'utf8'));
  if (manifest.converter !== 'tana-to-tine') throw new Error('Expected a tana-to-tine import manifest');
  const previous = JSON.parse(await fs.readFile(path.join(root, 'assets.json'), 'utf8'));
  const assets = await refreshAssetMap(root, previous, jobs, { retryDownloads });
  const statuses = {};
  let newlyAvailable = 0;
  for (const [key, value] of Object.entries(assets)) {
    statuses[value.status] = (statuses[value.status] ?? 0) + 1;
    if (previous[key].status === 'unavailable' && value.status !== 'unavailable') newlyAvailable++;
  }
  const report = JSON.parse(await fs.readFile(path.join(root, 'conversion-report.json'), 'utf8'));
  manifest.assets = assets;
  report.asset_statuses = statuses;
  await atomicJson(path.join(root, 'assets.json'), assets);
  await atomicJson(path.join(root, 'import-manifest.json'), manifest);
  await atomicJson(path.join(root, 'conversion-report.json'), report);
  return { graph: root, newly_available: newlyAvailable, asset_statuses: statuses };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const { values, positionals } = parseNodeArgs({ args: argv, allowPositionals: true, options: {
    jobs: { type: 'string', default: String(availableWorkers()) },
    'retry-downloads': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  } });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new Error('Expected one existing converted graph directory');
  const jobs = Number(values.jobs);
  validateJobs(jobs);
  return { graph: positionals[0], jobs, retryDownloads: values['retry-downloads'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs();
    if (args.help) console.log('Usage: node refresh-assets.mjs GRAPH [--jobs N] [--retry-downloads]\nRecheck asset files in place; jobs defaults to all available CPU cores.');
    else console.log(JSON.stringify(await refreshGraph(args.graph, args.jobs, args), null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
