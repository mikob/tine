/** Synthetic tests: no private exports, network, or original importer dependency. */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Converter } from "./tana_tine/converter.mjs";
import { Block, Names, Page, Source, encodePageName, safeProse, serializePage, sourceUuid } from "./tana_tine/model.mjs";
import { Compiler, NativeScope, UnsupportedQuery } from "./tana_tine/queries.mjs";
import { RichText, codeFence, escapeSourceHashtags } from "./tana_tine/richtext.mjs";
import { parseFieldNames, parseArgs, run } from "./tana-to-tine.mjs";

function node(identity, name = "", { kind = "node", owner = null, children = [], ...props } = {}) {
  const data = { name, _docType: kind, created: 1700000000000, ...props };
  if (owner) data._ownerId = owner;
  return { id: identity, props: data, children: [...children] };
}

function workspace(prefix, name, children = [], library = [], extra = []) {
  const root = `${prefix}-root`;
  const home = `${prefix}-home`;
  return { formatVersion: 1, docs: [
    node(root, "", { kind: "workspace" }), node(home, name, { kind: "home", owner: root, children }),
    node(`${root}_STASH`, "Library", { owner: root, children: library }),
    node(`${root}_SCHEMA`, "Schema", { owner: root }), node(`${root}_SEARCHES`, "Searches", { owner: root }), ...extra,
  ] };
}

function fixture() {
  const root = workspace("r", "Root Space", ["calendar", "query"], ["book"], [
    node("calendar", "Calendar", { kind: "journal", owner: "r-home", children: ["day"] }),
    node("day", "2025-01-02", { kind: "journalPart", owner: "calendar", children: ["daily"] }),
    node("daily", "Root daily note", { owner: "day" }),
    node("book", "A Book", { owner: "r-root_STASH", children: ["rating-tuple", "code", "prose"], _metaNodeId: "book-meta" }),
    node("book-meta", "", { kind: "metanode", owner: "book", children: ["book-tags"] }),
    node("book-tags", "", { kind: "tuple", owner: "book-meta", children: ["SYS_A13", "tag-book"] }),
    node("rating-tuple", "", { kind: "tuple", owner: "book", children: ["rating", "zero"] }),
    node("zero", "0", { owner: "rating-tuple" }),
    node("code", "id:: content\n- literal list\n``` inside", { kind: "codeblock", owner: "book" }),
    node("prose", "word:: prose\n## More\n- More", { owner: "book", _done: false }),
    node("query", "Books query", { kind: "search", owner: "r-home", children: ["book"], _metaNodeId: "query-meta" }),
    node("query-meta", "", { kind: "metanode", owner: "query", children: ["query-expr"] }),
    node("query-expr", "", { kind: "tuple", owner: "query-meta", children: ["SYS_A15", "tag-record"] }),
  ]);
  const work = workspace("w", "Work Space", ["work-calendar", "mirror"], ["work-library"], [
    node("work-calendar", "Calendar", { kind: "journal", owner: "w-home", children: ["work-day"] }),
    node("work-day", "2025-01-02", { kind: "journalPart", owner: "work-calendar", children: ["work-daily"] }),
    node("work-daily", "Work daily note", { owner: "work-day" }),
    node("work-library", "Work library item", { owner: "w-root_STASH" }),
    node("mirror", "Referenced items", { owner: "w-home", children: ["book"], _metaNodeId: "mirror-meta" }),
    node("mirror-meta", "", { kind: "metanode", owner: "mirror", children: ["mirror-views"] }),
    node("mirror-views", "", { kind: "tuple", owner: "mirror-meta", children: ["SYS_A16", "mirror-view"] }),
    node("mirror-view", "Table", { kind: "viewDef", owner: "mirror-views", _view: "table" }),
  ]);
  const shared = workspace("s", "Shared Space", ["rating", "tag-book", "tag-record"], [], [
    node("rating", "Rating", { kind: "attrDef", owner: "s-home", children: ["rating-type"] }),
    node("rating-type", "", { kind: "tuple", owner: "rating", children: ["SYS_T06", "SYS_NUMBER"] }),
    node("SYS_NUMBER", "Number"),
    node("tag-record", "Record", { kind: "tagDef", owner: "s-home" }),
    node("tag-book", "Book", { kind: "tagDef", owner: "s-home", _metaNodeId: "tag-book-meta" }),
    node("tag-book-meta", "", { kind: "metanode", owner: "tag-book", children: ["tag-book-tags"] }),
    node("tag-book-tags", "", { kind: "tuple", owner: "tag-book-meta", children: ["SYS_A13", "tag-record"] }),
  ]);
  return { Root: root, Work: work, Shared: shared };
}

const record = (exportData, identity) => exportData.docs.find((item) => item.id === identity);
const blocks = (graph) => [...graph.pages.values()].flatMap((page) => serializePage(page)[2]);
const queryFor = (graph, identity) => graph.queries.find((query) => query.source_id === identity);
const convert = (exports = fixture(), options = {}) => new Converter(new Source(exports), {
  rootWorkspace: "Root", sharedWorkspaces: ["Shared"], ...options,
}).finish();

function addTags(exportData, identity, ...tags) {
  const meta = `${identity}-test-meta`;
  const assignment = `${identity}-test-tags`;
  record(exportData, identity).props._metaNodeId = meta;
  exportData.docs.push(node(meta, "", { kind: "metanode", owner: identity, children: [assignment] }),
    node(assignment, "", { kind: "tuple", owner: meta, children: ["SYS_A13", ...tags] }));
}

describe("format", () => {
  test("filename encoder and collisions", () => {
    assert.equal(encodePageName("Project/Roadmap"), "Project___Roadmap");
    assert.equal(encodePageName("a___b"), "a%5F%5F%5Fb");
    assert.equal(encodePageName("CON.txt"), "%43ON.txt");
    assert.equal(encodePageName(".x. "), "%2Ex%2E%20");
    const names = new Names();
    const [first] = names.allocate("Café", "a");
    const [second] = names.allocate("CAFE\u0301", "b");
    assert.notEqual(first.toLowerCase(), second.toLowerCase());
  });

  test("fences keep properties outside code", () => {
    const page = new Page("Test", "pages/Test.md", "test", [], {}, [new Block(sourceUuid("code"), codeFence("id:: literal\n- child"))]);
    const [, output, expected] = serializePage(page);
    assert.ok(output.indexOf(`  id:: ${sourceUuid("code")}`) > output.lastIndexOf("  ```"));
    assert.equal(expected.length, 1);
  });

  test("prose cannot become metadata or children", () => {
    assert.equal(safeProse("title:: prose\n## Heading\n- a list"), "title:\\: prose\n\\## Heading\n\\- a list");
    assert.equal(safeProse("```\nid:: literal\n- a list\n```"), "```\nid:: literal\n- a list\n```");
  });

  test("unclosed and single line fences remain literal", () => {
    assert.equal(safeProse("```one-line```"), "\\```one-line```");
    assert.equal(safeProse("```python\nno closing fence"), "\\```python\nno closing fence");
  });

  test("drawer properties follow end", () => {
    const page = new Page("Test", "pages/Test.md", "test", [], {}, [new Block(sourceUuid("drawer"), ":LOGBOOK:\nCLOCK: [2025-01-02 Thu 09:00:00]\n:END:")]);
    const [, output] = serializePage(page);
    assert.ok(output.indexOf("  id:: ") > output.indexOf("  :END:"));
  });

  test("literal hashtags escape without a word boundary", () => {
    assert.equal(escapeSourceHashtags("x#Task #2026 #.topic #_topic #[[multi word]]"),
      "x\\#Task \\#2026 \\#.topic \\#_topic \\#[[multi word]]");
    assert.equal(escapeSourceHashtags("## Heading #topic"), "## Heading \\#topic");
    assert.equal(escapeSourceHashtags("\\#Task \\\\#Task"), "\\#Task \\\\\\#Task");
  });

  test("Unicode whitespace preserves source hashtag boundaries", () => {
    for (const whitespace of ["\u0085", "\u001c", "\u001d", "\u001e", "\u001f", "\u00a0", "\u2028"]) {
      assert.equal(escapeSourceHashtags(`#${whitespace}next`), `#${whitespace}next`);
      assert.equal(escapeSourceHashtags(`https://example.invalid/${whitespace}#tag`), `https://example.invalid/${whitespace}\\#tag`);
    }
    assert.equal(escapeSourceHashtags("#\ufeffnext"), "\\#\ufeffnext");
    assert.equal(escapeSourceHashtags("https://example.invalid/\ufeff#tag"), "https://example.invalid/\ufeff#tag");
  });

  test("large source code retains every backtick run", () => {
    const content = "`text".repeat(150000) + "````literal";
    assert.equal(codeFence(content, "c++\nunsafe"), `\x60\x60\x60\x60\x60c++unsafe\n${content}\n\x60\x60\x60\x60\x60`);
  });

  test("hashtag escaping preserves code links and URLs", () => {
    for (const content of ["`#Task`", "``#Task ` nested``", "```text\n#Task\n```", "~~~text\n#Task\n~~~~",
      "[[Page #Task]]", "[[Outer [[Inner #Task]] #Task]]", "[a#Task](https://example.invalid/#Task)",
      "![a#Task](../assets/example#Task.png)", "https://example.invalid/#Task", "www.example.invalid/#Task"]) {
      assert.equal(escapeSourceHashtags(content), content);
    }
  });

  test("conflicting IDs fail", () => {
    const exports = fixture();
    exports.Work.docs.push(node("book", "Conflicting record"));
    assert.throws(() => new Source(exports), /Conflicting source/);
  });
});

describe("rich text", () => {
  const render = (value, options) => new RichText((identity) => `node:${identity}`, (date) => `date:${date.dateTimeString}`, options).convert(value);

  test("nested reference labels are replaced once", () => {
    assert.equal(render('<span data-inlineref-node="a"><b>label</b><span data-inlineref-node="b">other</span></span> after'), "node:a after");
    assert.equal(render('<span data-inlineref-date="{&quot;dateTimeString&quot;:&quot;2025-01-02&quot;}">date</span>'), "date:2025-01-02");
    assert.equal(render('<span DATA-INLINEREF-NODE="a" data-inlineref-node="b">label</span>'), "node:b");
  });

  test("source nesting and self-closing markers do not acquire implied HTML closures", () => {
    assert.equal(render("<b>one<i>two</b>three</i>"), "**one*two***three");
    assert.equal(render("<p>a<p>b</p>c"), "a\nb\nc\n");
    assert.equal(render("a<br/>b</br>c"), "a\nbc");
    assert.equal(render("<b/>after"), "****after");
  });

  test("script style comments and raw text remain source data", () => {
    assert.equal(render('<script type="x">if (a < b) "&amp;"</script>after'), '&lt;script type=&quot;x&quot;&gt;if (a < b) "&amp;"&lt;/script&gt;after');
    assert.equal(render("<style>a {color:red}</style>"), "&lt;style&gt;a {color:red}&lt;/style&gt;");
    assert.equal(render("<script>no close"), "&lt;script&gt;no close&lt;/script&gt;");
    assert.equal(render("<title><b>bold</b> &amp;</title>"), "<b>bold</b> &");
    assert.equal(render("a<!-- hidden &amp; -->b"), "a&lt;!-- hidden &amp; --&gt;b");
    assert.equal(render("x <!--unfinished"), "x &lt;!--unfinished--&gt;");
    assert.equal(render("a<!doctype html><?processing?>b"), "ab");
    assert.equal(render("<p"), "");
  });

  test("links entities and asset callback preserve labels", () => {
    const content = '<a href="a&amp;b>c\nnext"><b>label</b></a><img src="image" alt="&amp;">';
    assert.equal(render(content), "[**label**](<a&b%3Ec%0Anext>)![&](<image>)");
    assert.equal(render(content, { plain: true }), "label&");
    assert.equal(render('<img src="image" alt="label">', { assetReference: (target, label, image) => `${target}:${label}:${image}` }), "image:label:true");
    assert.equal(render('<b style="font-weight: normal">normal</b>'), "normal");
    assert.equal(render('<a href="&notit;&amp=foo;">label</a>'), "[label](<&notit;&amp=foo;>)");
  });
});

describe("conversion", () => {
  let graph;
  let expected;
  let bySource;
  beforeEach(() => {
    graph = convert();
    expected = blocks(graph);
    bySource = Object.fromEntries(expected.filter((block) => block.source_id).map((block) => [block.source_id, block]));
  });

  test("workspace roles and library order", () => {
    const names = new Set([...graph.pages.values()].map((page) => page.name));
    assert.ok(!names.has("Root Space"));
    assert.ok(!names.has("Shared Space"));
    assert.ok(names.has("Work Space"));
    assert.equal(graph.pageFor.get("book").kind, "root");
    assert.equal(graph.pageFor.get("w-home").blocks.at(-1).sourceId, "w-root_STASH");
  });

  test("merged journal parentage", () => {
    const journal = [...graph.pages.values()].find((page) => page.kind === "journal");
    assert.equal(journal.path, "journals/2025_01_02.md");
    assert.equal(bySource.daily.parent, null);
    assert.equal(bySource["work-daily"].parent, graph.refs.get("work-day").target);
    assert.equal(journal.blocks[1].text.split("\n")[0], "[[Work Space]]");
  });

  test("types zero and tag inheritance", () => {
    assert.equal(graph.fields.get("rating").query_type, "number");
    assert.equal(bySource.book.properties.rating, "0");
    assert.ok(bySource.book.text.includes("#[[Book]]"));
    assert.ok(bySource.book.text.includes("#[[Record]]"));
    assert.ok(!bySource["tag-book"].text.includes("#[[Record]]"));
  });

  test("explicit undone and source placement", () => {
    assert.ok(bySource.prose.text.startsWith("TODO "));
    assert.ok(graph.sourceProvenance("book").source_placements.includes("mirror"));
    const view = queryFor(graph, "mirror");
    assert.equal(view.status, "snapshot");
    assert.ok(view.reason.includes("direct-child"));
  });

  test("explicit task state wins without erasing marker-looking title", () => {
    for (const [completed, title, text] of [[1700000000000, "TODO versus a label", "DONE TODO versus a label"],
      [false, "DONE appears in the title", "TODO DONE appears in the title"]]) {
      const exports = fixture();
      Object.assign(record(exports.Root, "prose").props, { name: title, _done: completed });
      const block = blocks(convert(exports)).find((item) => item.source_id === "prose");
      assert.equal(block.text, text);
    }
  });

  test("queries keep source and snapshots", () => {
    const query = queryFor(graph, "query");
    assert.equal(query.status, "translated");
    assert.ok(query.expression.includes("tag('Record')"));
    assert.deepEqual(query.result_ids, ["book"]);
    assert.ok(graph.definitions.has(query.source_definition_path));
    assert.ok(expected.some((block) => block.text === "Exported results"));
  });

  test("graph has only authored and native properties", () => {
    assert.equal(queryFor(graph, "query").expression, "@block and (tag('Record'))");
    const allowed = new Set([...graph.fields.values()].map((field) => field.key).concat(["id", "title", "collapsed"]));
    for (const block of expected) assert.ok(Object.keys(block.properties).every((key) => allowed.has(key) || key.startsWith("tine.")));
    for (const page of graph.pages.values()) {
      assert.notEqual(page.kind, "provenance-property");
      assert.ok(Object.keys(page.properties).every((key) => allowed.has(key) || key.startsWith("tine.")));
    }
    const manifest = graph.manifest(expected, Object.fromEntries([...graph.pages.values()].map((page) => [page.path, {}])));
    assert.equal(manifest.nodes.book.created, 1700000000000);
    assert.ok(manifest.nodes.book.source_placements.includes("mirror"));
    assert.deepEqual(manifest.tags["tag-book"].parents, ["tag-record"]);
    assert.equal(manifest.nodes.prose.done, false);
  });

  test("inactive tag matches are kept on an excluded archive page", () => {
    const exports = fixture();
    exports.Root.docs.push(
      node("r-root_TRASH", "", { owner: "r-root" }),
      node("archived", "Archived book", { owner: "r-root_TRASH", _metaNodeId: "archived-meta" }),
      node("archived-meta", "", { kind: "metanode", owner: "archived", children: ["archived-tags"] }),
      node("archived-tags", "", { kind: "tuple", owner: "archived-meta", children: ["SYS_A13", "tag-book"] }),
    );
    record(exports.Root, "query").children.push("archived");
    const converted = convert(exports);
    const query = queryFor(converted, "query");
    assert.equal(query.status, "translated");
    assert.ok(query.expression.includes("not (page.name = 'Tana import/Archived references')"));
    assert.equal(query.scope_validation.excluded_candidates, 1);
    assert.equal(converted.archivePage.blocks[0].uuid, sourceUuid("archived"));
    assert.equal(converted.archivePage.blocks[0].sourceId, "archived");
    assert.ok(converted.emitted.has("archived"));
  });

  test("active recovered tag match remains live", () => {
    const exports = fixture();
    record(exports.Root, "r-root_STASH").children = [];
    exports.Root.docs.push(node("r-root_TRASH", "", { owner: "r-root" }), node("archived", "Archived book", { owner: "r-root_TRASH" }));
    addTags(exports.Root, "archived", "tag-book");
    record(exports.Root, "query").children.push("archived");
    const converted = convert(exports);
    const query = queryFor(converted, "query");
    assert.equal(query.status, "translated");
    assert.equal(query.scope_validation.candidate_count, 1);
    assert.equal(query.scope_validation.excluded_candidates, 1);
    assert.ok(converted.recoveredPage.blocks.some((block) => block.sourceId === "book"));
    assert.ok(converted.archivePage.blocks.some((block) => block.sourceId === "archived"));
  });

  test("unbounded OR clause cannot widen native query", () => {
    const exports = fixture();
    exports.Root.docs.push(
      node("choice", "", { kind: "tuple", owner: "query-expr", children: ["SYS_A42", "tag-book", "words"] }),
      node("words", "Book", { owner: "choice" }),
    );
    record(exports.Root, "query-expr").children = ["SYS_A15", "choice"];
    const query = queryFor(convert(exports), "query");
    assert.equal(query.status, "snapshot");
    assert.ok(query.reason.includes("no positive"));
  });

  test("authored field scope rejects generated matches", () => {
    const compiler = new Compiler(graph, "query");
    assert.equal(compiler.compile(["rating"]), "@block and (prop('rating') is not null)");
    assert.equal(new NativeScope(graph).validate(compiler.scope).candidate_count, 1);
    graph.index.blocks.push(graph.generated("generated-rating", "Summary", { rating: "1" }));
    assert.throws(() => new NativeScope(graph).validate(compiler.scope), /inactive or generated/);
  });

  test("workspace scope uses native page and ancestor references", () => {
    const exports = fixture();
    for (const [workspaceName, identity] of [["Work", "work-daily"], ["Work", "work-library"], ["Root", "daily"]]) {
      addTags(exports[workspaceName], identity, "tag-book");
    }
    record(exports.Root, "daily").props.name += " [[Work Space]]";
    record(exports.Root, "query-expr").children.push("w-home");
    const converted = convert(exports);
    const query = queryFor(converted, "query");
    assert.equal(query.status, "translated");
    assert.ok(query.expression.includes("ref('Work Space')"));
    assert.equal(query.native_adaptations[0].native_page, "Work Space");
    const compiler = new Compiler(converted, "query");
    compiler.compile(["tag-record", "w-home"]);
    assert.deepEqual(new NativeScope(converted).candidates(compiler.scope), new Set(["daily", "work-daily", "work-library"].map(sourceUuid)));
  });

  test("workspace scope uses allocated title", () => {
    const converted = convert(fixture(), { workspaceTitles: { Work: "Research Space" } });
    assert.ok(new Compiler(converted, "query").compile(["tag-record", "w-home"]).includes("ref('Research Space')"));
  });

  test("workspace scope does not reintroduce historical ownership", () => {
    for (const mentionsWorkspace of [false, true]) {
      const exports = fixture();
      exports.Work.docs.push(node("w-root_TRASH", "", { owner: "w-root" }),
        node("archived", `Archived book${mentionsWorkspace ? " [[Work Space]]" : ""}`, { owner: "w-root_TRASH" }));
      addTags(exports.Work, "archived", "tag-book");
      record(exports.Root, "query").children.push("archived");
      record(exports.Root, "query-expr").children.push("w-home");
      const query = queryFor(convert(exports), "query");
      assert.equal(query.status, "translated");
      assert.equal(query.scope_validation.excluded_candidates, Number(mentionsWorkspace));
      assert.equal(query.scope_validation.candidate_count, 0);
    }
  });

  test("root workspace scope excludes named references and shared scope is explicit", () => {
    const compiler = new Compiler(graph, "query");
    const expression = compiler.compile(["tag-record", "r-home"]);
    assert.ok(expression.includes("tag('Record')"));
    assert.ok(expression.includes("not (ref('Work Space'))"));
    assert.equal(compiler.adaptations.get("r-home").native_scope, "outside-named-workspaces");
    assert.equal(new NativeScope(graph).validate(compiler.scope).candidate_count, 1);
    assert.throws(() => new Compiler(graph, "query").compile(["tag-record", "s-home"]), { name: UnsupportedQuery.name, message: /Flattened shared/ });
  });

  test("set and not set do not confuse blank with absent", () => {
    const compiler = new Compiler(graph, "query");
    assert.ok(compiler.field("rating", ["SYS_V60"]).includes("not (prop('rating') = '')"));
    assert.ok(compiler.field("rating", ["SYS_V59"]).includes("is null or prop('rating') = ''"));
  });

  test("unknown query keeps all clauses as snapshot", () => {
    const exports = fixture();
    exports.Root.docs.push(node("unknown", "IS UNKNOWN", { owner: "query-expr" }));
    record(exports.Root, "query-expr").children.push("unknown");
    const query = queryFor(convert(exports), "query");
    assert.equal(query.status, "snapshot");
    assert.equal(query.expression, null);
    assert.deepEqual(query.result_ids, ["book"]);
  });

  test("source is unchanged", () => {
    const exports = fixture();
    const original = structuredClone(exports);
    convert(exports);
    assert.deepEqual(exports, original);
  });

  test("empty numeric value does not destroy type", () => {
    const exports = fixture();
    record(exports.Root, "zero").props.name = "";
    const converted = convert(exports);
    assert.equal(converted.fields.get("rating").query_type, "number");
    assert.equal(blocks(converted).find((block) => block.source_id === "book").properties.rating, "");
  });

  test("inline links do not create duplicate UUID placeholders", () => {
    const exports = fixture();
    record(exports.Root, "prose").props.name = 'See <span data-inlineref-node="daily"></span>';
    const converted = convert(exports);
    assert.ok(converted.required.has("daily"));
    assert.ok(!converted.emitted.has(sourceUuid("daily")));
  });

  test("asset URLs inside fenced source code are not rewritten", () => {
    graph.assets["https://example.invalid/image.png"] = { status: "copied", path: "assets/image.png" };
    const content = "```text\nhttps://example.invalid/image.png\n```";
    assert.equal(graph.rich(content), content);
  });

  test("existing available asset keeps original path", () => {
    graph.assets["https://example.invalid/photo.png"] = { status: "available", path: "assets/original photo.png" };
    assert.ok(graph.assetReference("https://example.invalid/photo.png", "Photo", true).includes("../assets/original photo.png"));
    assert.ok(graph.rewriteAssets("https://example.invalid/photo.png").includes("../assets/original photo.png"));
  });

  test("literal source hashtag does not disable real supertags", () => {
    const exports = fixture();
    record(exports.Root, "book").props.name = "Title #Task x#comparison";
    const block = blocks(convert(exports)).find((item) => item.source_id === "book");
    assert.equal(block.text, "Title \\#Task x\\#comparison #[[Book]] #[[Record]]");
  });

  test("workspace view grouping ignores empty editor slot", () => {
    const exports = fixture();
    record(exports.Work, "mirror-view").children = ["view-groups", "view-columns"];
    exports.Work.docs.push(
      node("view-groups", "", { kind: "tuple", owner: "mirror-view", children: ["SYS_A34", "empty-group", "workspace-group"] }),
      node("empty-group", "", { owner: "view-groups" }),
      node("workspace-group", "", { kind: "tuple", owner: "view-groups", children: ["SYS_A74", "w-home"] }),
      node("view-columns", "", { kind: "tuple", owner: "mirror-view", children: ["SYS_A17", "workspace-column"] }),
      node("workspace-column", "", { kind: "tuple", owner: "view-columns", children: ["SYS_A74"] }),
    );
    const view = queryFor(convert(exports), "mirror");
    assert.ok(!Object.hasOwn(view.view_properties, "tine.group-field"));
    assert.ok(!Object.hasOwn(view.view_properties, "tine.fields"));
    assert.ok(view.view_limitations.some((limitation) => limitation.includes("Unsupported grouping")));
  });

  test("calendar query preserves context and direct day scope", () => {
    const exports = fixture();
    exports.Root.docs.push(
      node("calendar-search", "Daily summary", { kind: "search", owner: "day", _metaNodeId: "calendar-search-meta" }),
      node("calendar-search-meta", "", { kind: "metanode", owner: "calendar-search", children: ["calendar-search-expr"] }),
      node("calendar-search-expr", "", { kind: "tuple", owner: "calendar-search-meta", children: ["SYS_A15", "w-home", "on-day", "on-date"] }),
      node("on-day", "ON DAY NODE", { owner: "calendar-search-expr" }),
      node("on-date", "", { kind: "tuple", owner: "calendar-search-expr", children: ["SYS_A82", "relative-parent"] }),
      node("relative-parent", "PARENT", { owner: "on-date" }),
    );
    record(exports.Root, "day").children.push("calendar-search");
    const converted = convert(exports);
    const query = queryFor(converted, "calendar-search");
    assert.equal(query.status, "snapshot");
    assert.equal(query.expression, null);
    assert.ok(query.reason.includes("day placement"));
    assert.equal(converted.sourceProvenance("calendar-search").calendar_day, "2025-01-02");
  });
});

describe("field names", () => {
  function duplicateFields() {
    const exports = fixture();
    exports.Shared.docs.push(...["rating-a", "rating-z"].map((identity) => node(identity, "Rating", { kind: "attrDef", owner: "s-home" })));
    return exports;
  }

  test("override propagates to properties references types queries and views", () => {
    const exports = fixture();
    record(exports.Root, "prose").props.name = '<span data-inlineref-node="rating"></span>';
    record(exports.Root, "query-meta").children.push("query-views");
    record(exports.Root, "query-expr").children.push("rating-filter");
    exports.Root.docs.push(
      node("rating-filter", "", { kind: "tuple", owner: "query-expr", children: ["rating", "filter-zero"] }),
      node("filter-zero", "0", { owner: "rating-filter" }),
      node("query-views", "", { kind: "tuple", owner: "query-meta", children: ["SYS_A16", "query-view"] }),
      node("query-view", "Table", { kind: "viewDef", owner: "query-views", _view: "table", children: ["view-columns", "view-sort", "view-group"] }),
      node("view-columns", "", { kind: "tuple", owner: "query-view", children: ["SYS_A17", "rating-column"] }),
      node("rating-column", "", { kind: "tuple", owner: "view-columns", children: ["rating"] }),
      node("view-sort", "", { kind: "tuple", owner: "query-view", children: ["SYS_A19", "sort-rule"] }),
      node("sort-rule", "", { kind: "tuple", owner: "view-sort", children: ["SYS_A20", "rating", "sort-desc"] }),
      node("sort-desc", "NUM_DESC", { owner: "sort-rule" }),
      node("view-group", "", { kind: "tuple", owner: "query-view", children: ["SYS_A34", "rating-group"] }),
      node("rating-group", "", { kind: "tuple", owner: "view-group", children: ["rating"] }),
    );
    record(exports.Shared, "tag-book").children.push("tag-rating");
    exports.Shared.docs.push(node("tag-rating", "", { kind: "tuple", owner: "tag-book", children: ["rating"] }));
    const graph = convert(exports, { fieldNames: { rating: "score" } });
    const expected = blocks(graph);
    const bySource = Object.fromEntries(expected.filter((block) => block.source_id).map((block) => [block.source_id, block]));
    assert.equal(bySource.book.properties.score, "0");
    assert.ok(!Object.hasOwn(bySource.book.properties, "rating"));
    assert.ok(bySource.prose.text.includes("[[score]]"));
    assert.equal(graph.pageFor.get("rating").path, "pages/score.md");
    assert.equal(graph.pageFor.get("rating").properties["tine.type"], "number");
    assert.equal(graph.pageFor.get("tag-book").properties["tine.fields"], "score=number");
    assert.equal(graph.scalarIds.get("zero").property, "score");
    const query = queryFor(graph, "query");
    assert.equal(query.status, "translated");
    assert.ok(query.expression.includes("prop('score') = 0"));
    assert.deepEqual(query.view_properties, { "tine.view": "table", "tine.columns": "score", "tine.fields": "score=number",
      "tine.sort": "score desc", "tine.group-field": "prop:score" });
    const queryBlock = expected.find((block) => block.uuid === query.uuid);
    for (const [key, value] of Object.entries(query.view_properties)) assert.equal(queryBlock.properties[key], value);
    const manifest = graph.manifest(expected, Object.fromEntries([...graph.pages.values()].map((page) => [page.path, {}])));
    assert.deepEqual(manifest.field_names, { rating: "score" });
  });

  test("explicit names win without renaming unaffected defaults", () => {
    const exports = duplicateFields();
    const original = new Map([...convert(exports).fields].map(([identity, field]) => [identity, field.key]));
    const moved = convert(exports, { fieldNames: { rating: "score" } });
    for (const identity of ["rating-a", "rating-z"]) assert.equal(moved.fields.get(identity).key, original.get(identity));
    const claimed = convert(exports, { fieldNames: { "rating-z": "rating" } });
    assert.equal(claimed.fields.get("rating-z").key, "rating");
    assert.equal(claimed.fields.get("rating").key, `rating-${sourceUuid("rating").slice(0, 8)}`);
    assert.equal(claimed.fields.get("rating-a").key, original.get("rating-a"));
  });

  test("reserved suffix collisions are deterministic", () => {
    const exports = duplicateFields();
    const short = sourceUuid("rating").replaceAll("-", "").slice(0, 8);
    const overrides = { "rating-a": "rating", "rating-z": `rating-${short}` };
    const first = convert(exports, { fieldNames: overrides });
    for (const exportData of Object.values(exports)) exportData.docs.reverse();
    const second = convert(exports, { fieldNames: Object.fromEntries(Object.entries(overrides).reverse()) });
    const firstKeys = Object.fromEntries([...first.fields].map(([identity, field]) => [identity, field.key]));
    assert.deepEqual(firstKeys, Object.fromEntries([...second.fields].map(([identity, field]) => [identity, field.key])));
    assert.equal(firstKeys.rating, `rating-${sourceUuid("rating").replaceAll("-", "").slice(0, 12)}`);
    assert.equal(new Set(Object.values(firstKeys)).size, Object.keys(firstKeys).length);
  });

  test("unknown unsafe reserved and normalized collisions fail", () => {
    const source = new Source(duplicateFields());
    for (const fieldNames of [{ missing: "score" }, { book: "score" }]) {
      assert.throws(() => new Converter(source, { fieldNames }), /Unknown source field/);
    }
    for (const key of ["", "due date", "due_date", "Score", "score::", "x;y", "x=y", "[[score]]", "/score", "score/", "score\nvalue"]) {
      assert.throws(() => new Converter(source, { fieldNames: { rating: key } }), /Unsafe|normalized/);
    }
    for (const key of ["id", "priority", "state", "tags", "tine.type", "tine-hidden", "logseq.hidden", "hl-page", "template-including-parent"]) {
      assert.throws(() => new Converter(source, { fieldNames: { rating: key } }), /Reserved/);
    }
    for (const other of ["score", "Score", " score "]) {
      assert.throws(() => new Converter(source, { fieldNames: { rating: "score", "rating-a": other } }), /collide after normalization/);
    }
  });

  test("CLI rejects duplicate and malformed assignments", () => {
    for (const assignments of [["rating=score", "rating=quality"], ["rating=score", "rating=score"]]) {
      assert.throws(() => parseFieldNames(assignments), /Duplicate --field-name/);
    }
    for (const assignment of ["rating", "=score", "rating="]) {
      assert.throws(() => parseFieldNames([assignment]), /SOURCE_FIELD_ID=KEY/);
    }
  });

  test("CLI writes explicit names and manifest", async (context) => {
    const temporary = await mkdtemp(path.join(tmpdir(), "tana-to-tine-test-"));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const inputs = path.join(temporary, "exports");
    await mkdir(inputs);
    await Promise.all(Object.entries(fixture()).map(([name, exportData]) => writeFile(path.join(inputs, `${name}.json`), JSON.stringify(exportData))));
    const output = path.join(temporary, "graph");
    const args = parseArgs(["--input", inputs, "--output", output, "--root-workspace", "Root", "--shared-workspace", "Shared",
      "--field-name", "rating=score", "--skip-assets", "--jobs", "1"]);
    await run(args, { log: () => {} });
    const manifest = JSON.parse(await readFile(path.join(output, "import-manifest.json"), "utf8"));
    assert.deepEqual(manifest.field_names, { rating: "score" });
    assert.ok((await stat(path.join(output, "pages/score.md"))).isFile());
    await assert.rejects(stat(path.join(output, "pages/rating.md")), { code: "ENOENT" });
    assert.equal(manifest.expected_blocks.find((block) => block.source_id === "book").properties.score, "0");
  });
});
