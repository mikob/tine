#!/usr/bin/env node
/** Independently check an import manifest against Tine's bundled lsdoc parser.
 * Usage: node convert/validate_graph.mjs GRAPH [--jobs N] [--report PATH]
 * Run from a Tine checkout; no app build is needed. TypeScript is only used
 * to load the actual sheet schema parser from the checkout, without its UI.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = dirname(fileURLToPath(import.meta.url));
const tineRoot = resolve(here, "..");
const digest = payload => createHash("sha256").update(payload).digest("hex");
const identity = value => value.trim().toLowerCase().replace(/^\//, "").replace(/\/$/, "").normalize("NFC");
const keyIdentity = value => value.trim().replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[ _]/g, "-");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inside(root, path) {
  const target = resolve(root, path);
  const child = relative(root, target);
  if (isAbsolute(child) || child === ".." || child.startsWith(".." + sep)) throw new Error("Manifest path escapes graph: " + path);
  return target;
}

async function parser() {
  const wasm = await import("../src/render/wasm/lsdoc_wasm.js");
  const source = readFileSync(resolve(tineRoot, "src/render/wasm/lsdoc_wasm_bytes.ts"), "utf8");
  const { WASM_B64 } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  wasm.initSync({ module: Buffer.from(WASM_B64, "base64") });
  return wasm;
}

function checkPage(root, page, expected, wasm) {
  const errors = [], properties = [], actual = [];
  const fail = (check, details = {}) => errors.push({ path: page.path, check, ...details });
  const payload = readFileSync(inside(root, page.path));
  const raw = payload.toString("utf8");
  if (!Buffer.from(raw).equals(payload)) fail("invalid-utf8");
  if (!raw.endsWith("\n")) fail("missing-final-newline");
  if (page.sha256 && page.sha256 !== digest(payload)) fail("page-checksum");
  const document = JSON.parse(wasm.parse_document_json(raw, false));
  let current = null;
  for (const syntax of document.blocks) {
    if (syntax.kind === "bullet" || syntax.kind === "heading") {
      current = { start: syntax.span[0], syntax, properties: [], propertySpans: [] };
      actual.push(current);
    } else if (syntax.kind === "properties") {
      if (current) {
        current.properties.push(...syntax.props);
        current.propertySpans.push(syntax.span);
      } else properties.push(...syntax.props);
    }
  }
  const expectedPageProps = Object.entries(page.properties);
  if (JSON.stringify(properties) !== JSON.stringify(expectedPageProps)) fail("page-properties", { expected: expectedPageProps, actual: properties });
  if (actual.length !== expected.length) fail("block-count", { expected: expected.length, actual: actual.length });
  const stack = [], ids = [], schemas = [];
  function checkProperties(entries, owner) {
    const seen = new Set();
    for (const [key, value] of entries) {
      const normalized = keyIdentity(key);
      if (seen.has(normalized)) fail("duplicate-property", { owner, key });
      seen.add(normalized);
      if (key === "tine.type" && !/^(list of )?(text|number|date|checkbox|ref)$/.test(value)) fail("invalid-query-type", { owner, value });
      if (key === "tine.fields") schemas.push({ path: page.path, owner, value });
    }
  }
  checkProperties(properties, "page");
  for (let i = 0; i < actual.length; i++) {
    const block = actual[i], wanted = expected[i];
    const id = block.properties.find(([key]) => key === "id")?.[1];
    if (!id || !uuidPattern.test(id)) fail("missing-or-invalid-block-id", { index: i, id });
    if (id) ids.push(id);
    checkProperties(block.properties, id || i);
    const depth = block.syntax.level - 1;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1)?.id || null;
    stack.push({ depth, id });
    if (!wanted) continue;
    if (id !== wanted.uuid) fail("block-order-or-id", { index: i, expected: wanted.uuid, actual: id });
    if (depth !== wanted.depth || parent !== wanted.parent) fail("block-tree", { id, expected: [wanted.depth, wanted.parent], actual: [depth, parent] });
    if (block.syntax.kind !== "bullet") fail("unexpected-structural-heading", { id });
    if (depth >= 128) fail("block-depth-limit", { id, depth });
    if (JSON.stringify(block.properties) !== JSON.stringify(Object.entries(wanted.properties))) fail("block-properties", { id, expected: Object.entries(wanted.properties), actual: block.properties });
    const end = actual[i + 1]?.start ?? payload.length;
    const parts = [];
    let offset = block.start;
    for (const [start, stop] of block.propertySpans) {
      parts.push(payload.subarray(offset, start));
      offset = stop;
    }
    parts.push(payload.subarray(offset, end));
    const lines = Buffer.concat(parts).toString("utf8").split("\n");
    const prefix = "\t".repeat(wanted.depth);
    // Tine's editor writes a bare bullet when a user clears a block's text.
    if (lines[0] !== prefix + "-" && !lines[0].startsWith(prefix + "- ")) fail("block-prefix", { id });
    lines[0] = lines[0].slice(prefix.length + 2);
    for (let j = 1; j < lines.length - 1; j++) {
      if (!lines[j].startsWith(prefix + "  ")) fail("continuation-prefix", { id, line: j });
      lines[j] = lines[j].slice(prefix.length + 2);
    }
    const recovered = lines.join("\n").replace(/\n$/, "");
    if (recovered !== wanted.text) fail("block-text", { id, expected_length: wanted.text.length, actual_length: recovered.length, expected_sha256: digest(wanted.text), actual_sha256: digest(recovered) });
    // An EOF immediately after a bare marker word has different lsdoc semantics
    // from a file line ending in a newline. Match the emitted file boundary.
    const expectedSyntax = JSON.parse(wasm.parse_block_json(wanted.text + "\n", false)).find(node => node.kind === "bullet");
    if (expectedSyntax) {
      for (const field of ["marker", "priority", "size"]) {
        if (block.syntax[field] !== expectedSyntax[field]) fail("block-" + field, { id, expected: expectedSyntax[field], actual: block.syntax[field] });
      }
    }
  }
  return { path: page.path, name: page.name, sha256: digest(payload), blocks: actual.length, ids, schemas, refs: document.refs, errors };
}

async function sheetParser() {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const source = readFileSync(resolve(tineRoot, "src/sheet/config.ts"), "utf8");
  // parseFields/serializeFields only use local constants. Other exports are
  // never invoked, so their unrelated UI imports can be removed for this check.
  const emitted = ts.transpileModule(source.replace(/^import[\s\S]*?;\s*$/gm, ""), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(emitted).toString("base64"));
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help") {
    console.log("Usage: node convert/validate_graph.mjs GRAPH [--jobs N] [--report PATH]");
    return;
  }
  const root = resolve(args.shift());
  let jobs = availableParallelism(), reportPath = resolve(root, "validation-report.json");
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (flag === "--jobs") jobs = Number(value);
    else if (flag === "--report" && value) reportPath = resolve(value);
    else throw new Error("Unknown or incomplete argument: " + flag);
  }
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("jobs must be a positive integer");
  const manifest = JSON.parse(readFileSync(resolve(root, "import-manifest.json"), "utf8"));
  const pages = Array.isArray(manifest.pages) ? manifest.pages : Object.values(manifest.pages);
  const expected = new Map(pages.map(page => [page.path, []]));
  const errors = [], names = new Set(), physical = new Set(), expectedIds = new Set();
  for (const block of manifest.expected_blocks) {
    if (!expected.has(block.path)) throw new Error("Unknown expected page: " + block.path);
    expected.get(block.path).push(block);
    if (expectedIds.has(block.uuid)) errors.push({ check: "duplicate-expected-id", id: block.uuid });
    expectedIds.add(block.uuid);
  }
  for (const page of pages) {
    const name = identity(page.name), path = page.path.normalize("NFC").toLowerCase();
    if (names.has(name)) errors.push({ check: "duplicate-page-identity", page: page.name });
    if (physical.has(path)) errors.push({ check: "duplicate-file-identity", path: page.path });
    names.add(name);
    physical.add(path);
  }
  const groups = Array.from({ length: Math.min(jobs, Math.max(1, pages.length)) }, () => []);
  pages.forEach((page, index) => groups[index % groups.length].push({ page, expected: expected.get(page.path) }));
  const results = (await Promise.all(groups.map(items => new Promise((accept, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { root, items } });
    worker.once("message", accept);
    worker.once("error", reject);
    worker.once("exit", code => { if (code) reject(new Error("Parser worker exited: " + code)); });
  })))).flat();
  const ids = new Set(), missingPages = new Map();
  let blockCount = 0, blockReferenceCount = 0, schemaCount = 0;
  const sheets = await sheetParser();
  for (const result of results) {
    errors.push(...result.errors);
    blockCount += result.blocks;
    for (const id of result.ids) {
      if (ids.has(id)) errors.push({ check: "duplicate-persisted-id", path: result.path, id });
      ids.add(id);
    }
    for (const reference of result.refs.block) {
      blockReferenceCount++;
      if (!expectedIds.has(reference.toLowerCase())) errors.push({ check: "unresolved-block-reference", path: result.path, reference });
    }
    for (const reference of result.refs.page) {
      if (!names.has(identity(reference))) missingPages.set(reference, (missingPages.get(reference) || 0) + 1);
    }
    for (const schema of result.schemas) {
      schemaCount++;
      const parsed = sheets.parseFields(schema.value);
      const roundtrip = sheets.serializeFields(parsed);
      if (roundtrip !== schema.value) errors.push({ check: "sheet-schema-roundtrip", ...schema, roundtrip });
    }
  }
  let assetsVerified = 0;
  const assets = manifest.assets || {};
  for (const asset of Array.isArray(assets) ? assets : Object.values(assets)) {
    if (!asset.path) continue;
    const path = inside(root, asset.path);
    if (!existsSync(path)) errors.push({ check: "missing-asset", path: asset.path });
    else if (asset.sha256 && digest(readFileSync(path)) !== asset.sha256) errors.push({ check: "asset-checksum", path: asset.path });
    else assetsVerified++;
  }
  const report = { ok: errors.length === 0, parser: "Tine bundled lsdoc WASM", jobs: groups.length,
    pages: pages.length, blocks: blockCount, persisted_ids: ids.size, block_references: blockReferenceCount,
    schemas_roundtripped: schemaCount, assets_verified: assetsVerified,
    virtual_page_references: [...missingPages].map(([name, files]) => ({ name, files })),
    errors, file_checksums: Object.fromEntries(results.map(result => [result.path, result.sha256])) };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, virtual_page_references: missingPages.size, errors: errors.length, file_checksums: undefined, report: reportPath }));
  if (errors.length) process.exitCode = 1;
}

if (isMainThread) await main();
else {
  const wasm = await parser();
  parentPort.postMessage(workerData.items.map(({ page, expected }) => checkPage(workerData.root, page, expected, wasm)));
}
