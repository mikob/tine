# Tana exports to Tine

`tana-to-tine.mjs` converts Tana **JSON formatVersion 1** exports into an ordinary
Tine Markdown graph. It uses Node.js 22 or later, following Tine's other command-line
utilities. It has no dependency on another importer or a running Tana/Logseq app.

Install the converter's locked dependencies once:

```sh
npm ci --prefix tine/convert
```

Then run:

```sh
node tine/convert/tana-to-tine.mjs \
  --input exports/Root.json \
  --input exports/Shared.json \
  --input exports/Research.json \
  --output converted-graph \
  --root-workspace Root \
  --shared-workspace Shared \
  --asset-cache previous-asset-cache
```

From a standalone copy of this directory, run `npm ci`, then use
`node tana-to-tine.mjs` instead.
The export filename stem identifies a workspace. `--input` accepts a file or a
directory of JSON exports and can be repeated. Source files are read only.

Workspace roles are explicit and optional:

- `--root-workspace NAME` promotes that workspace's home and Library entries to
  individual root pages. Its daily notes stay at journal root.
- `--shared-workspace NAME` exposes schema and shared content as individual pages,
  without creating a page named for the workspace. The option is repeatable.
- Other workspace roots become pages, with their Library block last. Their
  daily notes appear below `[[Workspace page]]` grouping blocks in merged journals.
- `--workspace-title NAME=TITLE` overrides an ordinary workspace page title.
  Otherwise the source home title is retained.

Dates use `journals/YYYY_MM_DD.md` and the configured logical journal title.
Source calendar outlines remain navigable links to the merged journals. Root
library entries each receive a page, including entries that already represent a
tag or a property definition.

Use repeatable `--field-name SOURCE_FIELD_ID=KEY` options to choose readable
property names, for example `--field-name rating=score`. Source field IDs are
listed under `fields` in the manifest. The chosen key updates data properties,
property pages/references, type declarations, queries, and view settings together.
Keys must already be normalized lowercase, without spaces or underscores; native
names such as `priority` are reserved (use a distinct name such as `priority-score`).
Unknown IDs, duplicate overrides, unsafe names, and normalized collisions fail
before asset processing. Explicit names take precedence; unrelated default
mappings stay unchanged when possible. Overrides are saved as `field_names` in
the manifest and are also accepted by `new Converter(source, {fieldNames: {...}})`.

`--jobs` defaults to all CPU cores available to the process. Export parsing,
attachment discovery and page serialization run on a bounded worker-thread pool. Attachment copying/downloading, page writing and export
archival use bounded concurrent I/O. Identity allocation and graph assembly stay
deterministic. Use `--jobs 1` to reduce concurrency.

The converter builds a sibling staging directory and publishes the completed
graph only after every file has been serialized. A nonempty output is rejected
unless `--overwrite` is supplied and the directory has this converter's manifest.
Overwriting retains the previous graph as a timestamped sibling backup. Failed
staging directories are retained as diagnostic evidence and an asset cache.

## Attachments

The bundled `asset-cache.mjs` reuses checksum-verified bytes from repeated
`--asset-cache` directories, then attempts missing remote attachments. Local paths
are resolved against the export and cache locations. Converted links are relative
to `assets/`; original labels and image/link roles are retained.

`--no-download` checks and copies available local/cache files without network
requests. `--skip-assets` preserves links without checking/copying bytes and is
explicitly recorded in the manifest. Unavailable assets retain their original link
and a concrete reason in `assets.json`; conversion never invents file contents.

After adding missing files to an existing graph, recheck them in place:

```sh
node tine/convert/refresh-assets.mjs converted-graph --jobs 8
```

Add `--retry-downloads` to retry unavailable remote attachments. This refresh
retains existing names and paths and updates `assets.json`, `import-manifest.json`,
and `conversion-report.json`. Existing files stay in place; `--retry-downloads`
may add newly retrieved attachments.

## Data and behavior preserved

- Stable source identities become deterministic UUIDs; existing valid UUIDs are
  retained. A node has one canonical block/page; other placements are references.
- Page identity and portable filename collisions are disambiguated deterministically.
  The manifest preserves original titles and the final mappings.
- Supertags become tag pages. Ancestor tags are materialized on imported instances,
  and inheritance edges remain in the manifest. Tine does not enforce inheritance
  on future edits.
- Fields become normalized property keys with property-page `tine.type`
  declarations and appropriate tag/view `tine.fields` schemas. Empty values remain
  distinct from absent values, `false`, and `0`. Numbers use decimal spelling.
- Rich, multiline, comma-sensitive, repeated, or otherwise unsupported property
  values remain addressable content blocks. The converter reports when a field
  cannot safely participate in a native scalar query.
- Tasks preserve supported markers and Tana's explicit checked/unchecked state.
  Source timestamps remain in the manifest and source archives; they are not
  represented as native Tine edit history.
- Graph properties contain authored fields and required native identity, type,
  and view settings. Generated Tana IDs, activity flags, kinds, workspace IDs,
  relationships, and timestamps are never added as graph properties or hidden
  substitute fields.
- Supported search clauses become `{{tine-query …}}` blocks. Translation is
  all-or-nothing for each complete query, so an unknown condition never produces
  an incorrectly widened live search. **Every search retains its exported result
  snapshot and original definition**, whether translated or unsupported.
- Live queries require a positive tag, task, authored-field, or page-reference condition that
  excludes generated and inactive records. The converter checks a conservative
  candidate bound after recovering references: AND intersects bounds, OR unions
  them, and negation or missing-property conditions cannot supply a bound alone.
  Referenced inactive notes occupy `Tana import/Archived references`; live queries
  exclude that allocated page by its native page name. Active recovered notes stay
  on their own page and remain eligible. A possible unwanted match elsewhere
  disables the entire live query. These queries use
  native tags, fields, and references, so future Tine edits participate naturally.
- Named workspace scopes become native `ref('Workspace page')` predicates. They
  include blocks on that page and blocks referencing it directly or through an
  ancestor, including workspace groups in merged journals. Explicit links from
  other pages participate too. The configured root workspace becomes the
  complement of all named workspace reference scopes; an explicit “any accessible
  workspace” search remains graph-wide. Flattened shared workspaces have no
  separate native scope. Each adaptation is recorded in the manifest.
- Table/list presentation, column order, supported sort settings, and one supported
  grouping are mapped to Tine view properties. Calendar/cards/tiles retain their
  data in table presentation with an explicit limitation.
- Source ownership, child placements, links, and calendar context remain distinct
  manifest data. Workspace searches use the native reference scopes described
  above. Other unsupported source relationships and direct-child views remain
  explicit snapshots/retained outlines, with their full definitions linked.
- Tana defaults, formulas, commands, automation, unknown UI settings, deleted
  records, and editor history are retained in the source archives. They are not
  silently executed or assigned invented Tine behavior. Referenced deleted notes
  remain addressable by their stable block references on the excluded archive page.

## Output and audit trail

```text
converted-graph/
  logseq/config.edn
  pages/
  journals/
  assets/
    tana-source/exports/       # Byte-for-byte source copies, verified by SHA-256
    tana-source/definitions/   # Search/view definitions and exported result IDs
  assets.json
  conversion-report.json
  import-manifest.json
```

The JSON files outside `pages/` and `journals/` are not imported pages. The `Tana
import` page links to source exports and structural anchors. Recovered notes have
an original-context link when the export identifies a containing content node.

Manifest format version 1 contains:

| Member | Purpose |
| --- | --- |
| `sources` | Source paths, workspace stems, sizes, record counts, SHA-256 hashes |
| `roles` | Configured workspace roles and title overrides |
| `nodes` | Every source ID's canonical placement, scalar mapping, structural reference, or archival status; source activity, ownership/placements, links, calendar context, and timestamps |
| `pages` | Logical titles, physical paths, page properties, root block IDs, content hashes |
| `expected_blocks` | UUID, source ID, page, parent, depth, exact serialized body/properties, ordered children |
| `fields` / `tags` | Source schema identities, target keys/types, options, inheritance mappings |
| `field_names` | Explicit source-field-ID to property-key overrides |
| `queries` | Source/view/context IDs, inner TQL expression, status/reason, snapshot IDs, definition path |
| `assets` | Source attachment locations, availability, target path, size, checksum, failure reason |
| `issues` / `renames` | Concrete fidelity limitations and deterministic identity disambiguations |

## Validation

Run the synthetic converter, attachment, worker and CLI tests with Node's built-in
test runner; no private exports are needed:

```sh
npm --prefix tine/convert test
```

In a Tine checkout, the independent validator parses **every emitted page** with
the bundled lsdoc WASM parser and checks the actual result against the manifest:

```sh
node tine/convert/validate_graph.mjs converted-graph --jobs 8
```

It checks block ownership/order/text/properties, UUID and reference resolution,
page identity, asset checksums, and the actual TypeScript sheet-schema round trip.
It uses the checkout's bundled WASM and its available TypeScript dependency;
these are validation dependencies, not converter dependencies. Parsing alone does
not prove native query execution or UI behavior. Use the target Tine version's
query/index runtime for query-result checks and open a disposable copy for UI
verification before replacing a working graph.
