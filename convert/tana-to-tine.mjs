#!/usr/bin/env node
/** Convert Tana formatVersion 1 JSON exports to a staged Tine Markdown graph. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Converter } from './tana_tine/converter.mjs';
import { Source } from './tana_tine/model.mjs';
import { buildAssetMap, digest, resolvePath, statIfExists } from './asset-cache.mjs';
import { availableWorkers, mapConcurrent, mapWorkers, validateJobs } from './workers.mjs';
import { applyImportDecisions, recordImportDecisions } from './import-decisions.mjs';

export const CONFIG = `{:meta/version 1
 :preferred-format "Markdown"
 :preferred-workflow :todo
 :pages-directory "pages"
 :journals-directory "journals"
 :file/name-format :triple-lowbar
 :journal/file-name-format "yyyy_MM_dd"
 :journal/page-title-format "MMM do, yyyy"}
`;

export const availableCores = availableWorkers;
const progress = message => console.error(message);
const elapsed = start => Math.round((performance.now() - start)) / 1000;
const counts = values => {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
};

export async function collectPaths(inputs) {
  const paths = [];
  for (const value of inputs) {
    const filename = await resolvePath(value);
    const info = await statIfExists(filename);
    if (info?.isDirectory()) {
      const names = (await fs.readdir(filename)).filter(name => name.endsWith('.json')).sort();
      paths.push(...names.map(name => path.join(filename, name)));
    } else if (info?.isFile()) paths.push(filename);
    else throw new Error(`Input does not exist: ${filename}`);
  }
  const unique = [...new Set(paths)];
  if (!unique.length) throw new Error('No JSON exports selected');
  return unique;
}

export async function jsonWrite(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function archiveExport([filename, destination, expectedHash]) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(filename, destination);
  const [actual] = await digest(destination);
  if (actual !== expectedHash) throw new Error(`Source export changed during conversion: ${filename}`);
}

export function parseFieldNames(assignments) {
  const entries = new Map();
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    const identity = assignment.slice(0, separator);
    const key = assignment.slice(separator + 1);
    if (separator < 1 || !key) throw new Error('--field-name requires SOURCE_FIELD_ID=KEY');
    if (entries.has(identity)) throw new Error(`Duplicate --field-name override for source field ${identity}`);
    entries.set(identity, key);
  }
  return Object.fromEntries(entries);
}

export async function run(args, { log = progress } = {}) {
  const started = performance.now();
  validateJobs(args.jobs);
  const fieldNames = parseFieldNames(args.fieldName);
  const inputs = await collectPaths(args.input);
  const output = await resolvePath(args.output);
  if (inputs.some(filename => {
    const relative = path.relative(output, filename);
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  })) throw new Error('Output must not contain or replace an input export');
  const existing = await statIfExists(output);
  if (existing && !existing.isDirectory()) throw new Error(`Output is not a graph directory: ${output}`);
  if (existing && (await fs.readdir(output)).length) {
    if (!args.overwrite) throw new Error('Output is nonempty; use --overwrite only for an existing generated graph');
    const manifestFile = path.join(output, 'import-manifest.json');
    if (!(await statIfExists(manifestFile))?.isFile() || JSON.parse(await fs.readFile(manifestFile, 'utf8')).converter !== 'tana-to-tine') throw new Error('--overwrite requires an existing tana-to-tine import manifest');
  }
  const titles = new Map();
  for (const item of args.workspaceTitle) {
    const separator = item.indexOf('=');
    if (separator < 1 || separator === item.length - 1) throw new Error('--workspace-title requires WORKSPACE=TITLE');
    titles.set(item.slice(0, separator), item.slice(separator + 1));
  }
  log(`Loading ${inputs.length} workspace exports with up to ${args.jobs} workers`);
  const source = await Source.read(inputs, args.jobs);
  const converter = new Converter(source, { rootWorkspace: args.rootWorkspace, sharedWorkspaces: args.sharedWorkspace,
    workspaceTitles: Object.fromEntries(titles), fieldNames });
  await fs.mkdir(path.dirname(output), { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(output), '.tana-to-tine-'));
  try {
    let assets = {};
    if (!args.skipAssets) {
      log('Copying cached assets and collecting attachment availability');
      assets = await buildAssetMap(inputs, stage, args.jobs, { cacheDirs: args.assetCache.map(directory => path.resolve(directory)), download: !args.noDownload,
        progress: (done, total) => { if (done % 100 === 0 || done === total) log(`Attachments checked: ${done}/${total}`); } });
    }
    log(`Mapping ${source.nodes.size} unique source nodes`);
    converter.assets = assets;
    converter.finish();
    if (args.decisions) {
      log('Applying source field and page decisions');
      await applyImportDecisions(converter, JSON.parse(await fs.readFile(args.decisions, 'utf8')), args.jobs);
    }
    log(`Serializing ${converter.pages.size} pages in parallel`);
    const rendered = await mapWorkers('serializePage', converter.pages.values(), args.jobs);
    const expected = [];
    const files = {};
    await mapConcurrent(rendered, args.jobs, async ([relative, content]) => {
      const filename = path.join(stage, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, content, 'utf8');
    });
    for (const [relative, content, blocks] of rendered) {
      for (const block of blocks) expected.push(block);
      files[relative] = { sha256: createHash('sha256').update(content).digest('hex'), block_count: blocks.length };
    }
    await fs.mkdir(path.join(stage, 'logseq'));
    await fs.writeFile(path.join(stage, 'logseq/config.edn'), CONFIG, 'utf8');
    log('Archiving untouched exports and writing the conversion manifest');
    await mapConcurrent(source.files.map(info => [info.path, path.join(stage, 'assets/tana-source/exports', `${info.workspace}.json`), info.sha256]), args.jobs, archiveExport);
    await mapConcurrent(converter.definitions, args.jobs, ([relative, definition]) => jsonWrite(path.join(stage, relative), definition));
    const manifest = converter.manifest(expected, files);
    recordImportDecisions(manifest, converter);
    manifest.run = { jobs: args.jobs, elapsed_seconds: elapsed(started), assets_requested: !args.skipAssets,
      download_requested: !args.noDownload && !args.skipAssets };
    await jsonWrite(path.join(stage, 'assets.json'), assets);
    await jsonWrite(path.join(stage, 'import-manifest.json'), manifest);
    const report = { counts: manifest.counts, issues_by_code: counts(manifest.issues.map(issue => issue.code)),
      fidelity: manifest.fidelity, asset_statuses: counts(Object.values(assets).map(asset => asset.status)),
      source_sha256: Object.fromEntries(source.files.map(info => [info.workspace, info.sha256])) };
    await jsonWrite(path.join(stage, 'conversion-report.json'), report);
    if (await statIfExists(output)) {
      if ((await fs.readdir(output)).length) {
        const previous = `${output}.previous-${Date.now()}-${process.hrtime.bigint()}`;
        await fs.rename(output, previous);
        try { await fs.rename(stage, output); }
        catch (error) { await fs.rename(previous, output); throw error; }
        log(`Previous generated graph retained at ${previous}`);
      } else {
        await fs.rmdir(output);
        await fs.rename(stage, output);
      }
    } else await fs.rename(stage, output);
    return { output, ...report, elapsed_seconds: elapsed(started) };
  } catch (error) {
    log(`Conversion did not complete; staging evidence retained at ${stage}`);
    throw error;
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const { values } = parseNodeArgs({ args: argv, options: {
    input: { type: 'string', multiple: true, default: [] }, output: { type: 'string' },
    'root-workspace': { type: 'string' }, 'shared-workspace': { type: 'string', multiple: true, default: [] },
    'workspace-title': { type: 'string', multiple: true, default: [] }, 'field-name': { type: 'string', multiple: true, default: [] },
    jobs: { type: 'string', default: String(availableCores()) }, 'asset-cache': { type: 'string', multiple: true, default: [] },
    decisions: { type: 'string' },
    'no-download': { type: 'boolean', default: false }, 'skip-assets': { type: 'boolean', default: false },
    overwrite: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  } });
  if (values.help) return { help: true };
  if (!values.input.length || !values.output) throw new Error('--input and --output are required');
  const jobs = Number(values.jobs);
  validateJobs(jobs);
  return { input: values.input, output: values.output, rootWorkspace: values['root-workspace'] ?? null,
    sharedWorkspace: values['shared-workspace'], workspaceTitle: values['workspace-title'], fieldName: values['field-name'], jobs,
    assetCache: values['asset-cache'], noDownload: values['no-download'], skipAssets: values['skip-assets'], overwrite: values.overwrite,
    decisions: values.decisions ?? null };
}

const HELP = `Usage: node tana-to-tine.mjs --input EXPORT --output GRAPH [options]
  --input FILE|DIR                  Tana formatVersion 1 exports; repeatable
  --root-workspace NAME             Promote home/library entries to root pages
  --shared-workspace NAME           Shared schema/content; repeatable
  --workspace-title WORKSPACE=TITLE  Override an ordinary workspace page title
  --field-name SOURCE_FIELD_ID=KEY   Explicit normalized field key; repeatable
  --decisions FILE                  Source-ID field/page merges, renames and exclusions
  --jobs N                         Parallel workers (default: all available cores)
  --asset-cache DIR                Existing attachment cache; repeatable
  --no-download                    Reuse local/cache bytes without network requests
  --skip-assets                    Preserve links without checking/copying bytes
  --overwrite                      Replace a generated graph, keeping a backup
`;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs();
    if (args.help) console.log(HELP);
    else console.log(JSON.stringify(await run(args), null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
