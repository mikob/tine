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
Inline calendar dates link to those journals; ranges link both endpoints. Timed
references keep their local clock time, precision, UTC offset and timezone next
to the journal link. All-day dates keep the stated day without a timezone shift.
Unrecognized date forms remain source text, and original metadata stays in the
archived exports. Generated page headers only include `title` when the filename
does not supply the intended name, such as a shortened filename for a long title.
Source calendar outlines are omitted. Daily notes use their original date;
weekly notes use the Sunday starting that week (for example, `2025-W17` goes to
April 20, 2025), monthly notes use the first day of the month, and yearly notes
use January 1. Notes from the same workspace and date share one workspace
reference group; root-workspace notes stay at journal root. Empty source periods
do not create empty journals unless a note references them. No separate week,
month, or year pages are generated. Authored period metadata and note IDs, tags,
properties, and children are preserved; the source period stays in the manifest.
Root library entries each receive a page, including entries that already
represent a tag or a property definition.

Source `heading` fields with levels 1–6 become Markdown headings. Matching
headings are kept as written. Redundant `title` fields are omitted, including
date labels that name the same journal day; a title on an otherwise untitled
block becomes its visible text. Different titles, conflicting heading levels,
and rich field values remain source content.

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

To combine source fields that have the same meaning, use the separate Node.js
merge command after conversion. It also works on an already edited graph, without
regenerating its notes. It requires a Tine checkout for the bundled document parser.
Create a JSON plan using source field IDs from the manifest:

~~~json
{
  "groups": [
    {
      "key": "quantity",
      "query_type": "number",
      "fields": ["SOURCE_FIELD_A", "SOURCE_FIELD_B"]
    }
  ]
}
~~~

~~~sh
node tine/convert/merge-properties.mjs converted-graph \
  --plan property-merges.json --stage merged-stage
node tine/convert/merge-properties.mjs --publish merged-stage
~~~

Inspect or open the stage before publishing. Staging checks the parsed syntax of
every changed document, preserves all block IDs and definition trees, and records
its checks in property-merge-validation.json. It uses all available cores unless
--jobs is provided. A sibling merged-stage.before directory retains the original
Markdown and metadata; the original graph's assets remain in place. The staged
graph links to those unchanged assets.

Choose one explicit global query type per merge; this does not coerce stored
values. For example, unit-bearing prices can share a text property, and scalar
notes can share a list-of-text declaration with list-valued notes. Local
tine.fields types and enum choices stay attached to their existing views.
Definition pages are consolidated, and property keys, page links, queries,
columns, grouping, sorting, aggregates and table widths follow the mapping.
Code literals remain literal. Conflicting properties on the same owner,
incompatible duplicate schema entries, affected formulas/filters, occupied page
names and invalid numeric/date/checkbox values stop staging. Review those cases
before merging; identical spelling alone is not a reason to merge fields.

Publishing refuses intervening edits and retains the backup. The manifest records
the merge plan and previous field descriptors under property_merges, while
working_graph records current file hashes and property pages. Its original
pages, expected_blocks and counts remain the conversion baseline; the
original import validator is for that baseline, not subsequent user edits.

For a fresh import, pass --decisions decisions.json to apply source-ID decisions
before serialization. This supports page/tag merges and definition exclusions as
well as field merges. It requires the bundled parser in a Tine checkout. Existing
--field-name overrides can still be used alongside it.

~~~json
{
  "fields": [
    {"sources": ["FIELD_A", "FIELD_B"], "key": "quantity", "query_type": "number"},
    {"sources": ["FIELD_C"], "key": "contact-email", "query_type": "text"}
  ],
  "pages": [
    {"sources": ["TAG_A", "PAGE_B"], "name": "Research"}
  ],
  "exclude_fields": ["UNUSED_FIELD"],
  "exclude_pages": ["UNUSED_TAG"]
}
~~~

The first source in each page group supplies the destination page. All member
blocks and source identities are retained there in order. Merging a tag keeps
its membership and updates references and queries. Excluding a tag removes its
definition and tag markers while retaining the tagged records; excluding a field
removes its definition and assignments. Ordinary page exclusions remove that
page's outline, so select source IDs deliberately. Deleted definitions remain in
the archived exports, and the manifest lists every removed block ID. Conflicting
values, incompatible page schemas, overlapping decisions and live queries that
depend on an excluded definition fail the import.

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
  an incorrectly widened live search. Every search retains its exported result
  IDs and original definition in JSON assets. These audit records are not added
  as child blocks beneath queries. Notes actually authored inside a search stay
  in its outline; cached result references do not create duplicate placements.
  Unsupported queries emit no warning/placeholder blocks, and empty search
  labels are omitted unless a note references them. The reason a query could
  not be translated remains in `import-manifest.json` alongside its definition.
- Live queries require a positive tag, task, authored-field, or page-reference condition that
  excludes generated records. The converter checks a conservative
  candidate bound after recovering references: AND intersects bounds, OR unions
  them, and negation or missing-property conditions cannot supply a bound alone.
  Cached search hits do not restore archived notes. Notes explicitly referenced
  by retained content remain addressable under `Recovered notes`, alongside
  active notes missing from the exported outline. They participate in native
  queries like other retained notes, without migration-specific exclusions.
  A possible generated or missing-source match disables the entire live query. These queries use
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
  retained outlines and JSON snapshots, with definition paths in the manifest.
- Tana defaults, formulas, commands, automation, unknown UI settings, deleted
  records, and editor history are retained in the source archives. They are not
  silently executed or assigned invented Tine behavior. Directly referenced
  deleted notes retain their stable block IDs; unreferenced deleted content stays
  in the source archives. No migration index or separate archive page is created.

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
