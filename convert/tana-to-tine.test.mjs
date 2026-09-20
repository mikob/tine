/** Synthetic tests: no private exports, network, or original importer dependency. */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Converter, titleMatchesDay } from "./tana_tine/converter.mjs";
import { Block, Names, Page, Source, encodePageName, safeProse, serializePage, sourceUuid } from "./tana_tine/model.mjs";
import { Compiler, NativeScope, UnsupportedQuery } from "./tana_tine/queries.mjs";
import { RichText, codeFence, escapeSourceHashtags } from "./tana_tine/richtext.mjs";
import { parseFieldNames, parseArgs, run } from "./tana-to-tine.mjs";
import { applyImportDecisions, recordImportDecisions } from "./import-decisions.mjs";
import {parser} from './property-rewrite.mjs';

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

function fieldValue(exports, owner, field, name, value, suffix = '') {
  const tuple = `${owner}-${field}-tuple${suffix}`, scalar = `${tuple}-value`;
  if (!record(exports.Shared, field)) exports.Shared.docs.push(node(field, name, {kind: 'attrDef', owner: 's-home'}));
  const workspaceData = Object.values(exports).find(data => record(data, owner));
  record(workspaceData, owner).children.push(tuple);
  workspaceData.docs.push(node(tuple, '', {kind: 'tuple', owner, children: [field, scalar]}), node(scalar, value, {owner: tuple}));
  return scalar;
}

test('heading fields become native headings without changing nested content or task markers', async () => {
  const exports = fixture();
  record(exports.Root, 'daily').props.name = 'TODO Follow up';
  fieldValue(exports, 'daily', 'heading-field', 'heading', '3');
  fieldValue(exports, 'book', 'heading-field', 'heading', '2');
  record(exports.Root, 'book').props.name = '## A Book';
  const graph = convert(exports), expected = blocks(graph), parse = await parser();
  const daily = expected.find(b => b.source_id === 'daily');
  assert.equal(daily.text, '### TODO Follow up');
  assert.equal(daily.properties['source-heading'], undefined);
  assert.ok(expected.find(b => b.source_id === 'book').text.startsWith('## A Book '));
  const page = [...graph.pages.values()].find(p => p.path === daily.path);
  const syntax = parse(serializePage(page)[1]).blocks.find(b => b.kind === 'bullet');
  assert.equal(syntax.size, 3);
  assert.equal(syntax.marker, 'TODO');
  assert.equal(expected.filter(b => b.source_id === 'code').length, 1);
});

test('invalid, conflicting and rich heading fields stay lossless', () => {
  const exports = fixture();
  fieldValue(exports, 'daily', 'heading-field', 'heading', '7');
  fieldValue(exports, 'book', 'heading-field', 'heading', '2');
  record(exports.Root, 'book').props.name = '# A Book';
  const rich = fieldValue(exports, 'work-daily', 'heading-field', 'heading', '3');
  record(exports.Work, rich).children.push('heading-note');
  exports.Work.docs.push(node('heading-note', 'Authored context', {owner: rich}));
  const expected = blocks(convert(exports));
  assert.equal(expected.find(b => b.source_id === 'daily').properties['source-heading'], '7');
  assert.equal(expected.find(b => b.source_id === 'book').properties['source-heading'], '2');
  assert.ok(expected.find(b => b.source_id === 'heading-note'));
});

test('duplicate titles and date labels disappear, blank titles become visible, distinct titles survive', () => {
  const exports = fixture();
  fieldValue(exports, 'book', 'title-field', 'title', 'A Book');
  fieldValue(exports, 'day', 'title-field', 'title', '2025/01/02');
  fieldValue(exports, 'work-daily', 'title-field', 'title', 'Alternate title');
  record(exports.Root, 'daily').props.name = '';
  fieldValue(exports, 'daily', 'title-field', 'title', 'Visible title');
  const graph = convert(exports), expected = blocks(graph);
  assert.equal(expected.find(b => b.source_id === 'book').properties['source-title'], undefined);
  assert.equal(graph.dayPage('2025-01-02').properties['source-title'], undefined);
  assert.equal(expected.find(b => b.source_id === 'daily').text, 'Visible title');
  assert.equal(expected.find(b => b.source_id === 'work-daily').properties['source-title'], 'Alternate title');
  assert.equal(titleMatchesDay('2019/21/05', '2019-05-21'), true);
  assert.equal(titleMatchesDay('2019/01/05', '2019-05-01'), false);
});

test('rich title values and native scalar reference targets retain their content', () => {
  const exports = fixture();
  const title = fieldValue(exports, 'book', 'title-field', 'title', 'A Book');
  record(exports.Root, title).children.push('title-note');
  exports.Root.docs.push(node('title-note', 'Title context', {owner: title}));
  const heading = fieldValue(exports, 'daily', 'heading-field', 'heading', '2');
  record(exports.Work, 'work-daily').props.name += ` <span data-inlineref-node="${heading}"></span>`;
  const expected = blocks(convert(exports));
  assert.ok(expected.find(b => b.source_id === 'book').properties['source-title']);
  assert.ok(expected.find(b => b.source_id === 'title-note'));
  assert.ok(expected.find(b => b.source_id === heading));
});

test('unsupported query placeholders disappear while definitions and authored children remain', () => {
  const exports = fixture();
  exports.Root.docs.push(node('unknown', 'IS UNKNOWN', {owner: 'query-expr'}));
  record(exports.Root, 'query-expr').children.push('unknown');
  const graph = convert(exports), expected = blocks(graph), query = queryFor(graph, 'query');
  assert.equal(query.status, 'snapshot');
  assert.equal(query.visible, false);
  assert.ok(graph.definitions.has(query.source_definition_path));
  assert.ok(!expected.some(b => b.uuid === query.uuid || b.source_id === 'query'));
  assert.ok(!expected.some(b => /Source search:|Live query unavailable:/.test(b.text)));
  exports.Root.docs.push(node('search-note', 'Authored child', {owner: 'query'}));
  record(exports.Root, 'query').children.push('search-note');
  const retained = blocks(convert(exports));
  assert.ok(retained.some(b => b.source_id === 'query'));
  assert.ok(retained.some(b => b.source_id === 'search-note'));
});

test('referenced unsupported search labels stay resolvable', () => {
  const exports = fixture();
  record(exports.Root, 'r-home').children = ['calendar'];
  record(exports.Root, 'day').children.push('query');
  record(exports.Root, 'query').props._ownerId = 'day';
  exports.Root.docs.push(node('unknown', 'IS UNKNOWN', {owner: 'query-expr'}));
  record(exports.Root, 'query-expr').children.push('unknown');
  record(exports.Root, 'daily').props.name += ' <span data-inlineref-node="query"></span>';
  const graph = convert(exports);
  assert.ok(blocks(graph).some(b => b.source_id === 'query'));
  graph.validateIds();
});

test('weekly projects join Sunday journals without calendar outlines or duplicate workspace groups', () => {
  const exports = fixture();
  record(exports.Work, 'work-calendar').children.push('year');
  exports.Work.docs.push(
    node('year', '2025', {kind: 'journalPart', owner: 'work-calendar', children: ['week']}),
    node('week', 'Week 17', {kind: 'journalPart', owner: 'year', children: ['weekly-project'], _metaNodeId: 'week-meta'}),
    node('week-meta', '', {kind: 'metanode', owner: 'week', children: ['week-date']}),
    node('week-date', '', {kind: 'tuple', owner: 'week-meta', children: ['SYS_A169', 'week-value']}),
    node('week-value', '<span data-inlineref-date="{&quot;dateTimeString&quot;:&quot;2025-W17&quot;}"></span>', {owner: 'week-date'}),
    node('weekly-project', 'An important project', {owner: 'week', children: ['project-note']}),
    node('project-note', 'Preserved plan', {owner: 'weekly-project'}),
    node('w-root_TRASH', '', {owner: 'w-root', children: ['weekly-project']}),
  );
  addTags(exports.Work, 'weekly-project', 'tag-book');
  record(exports.Work, 'work-day').props.name = '2025-04-20';
  const graph = convert(exports), page = graph.pageFor.get('w-home'), expected = blocks(graph);
  const sunday = graph.dayPage('2025-04-20'), group = sunday.blocks.find(b => b.text === '[[Work Space]]');
  assert.deepEqual(group.children.map(b=>b.sourceId), ['work-daily', 'weekly-project']);
  assert.equal(graph.refs.get('week').target, group.uuid);
  assert.ok(!page.blocks.some(b=>['year','week','work-calendar'].includes(b.sourceId)));
  assert.equal(page.blocks.at(-1).sourceId, 'w-root_STASH');
  assert.equal(expected.filter(b => b.source_id === 'weekly-project').length, 1);
  assert.equal(expected.find(b => b.source_id === 'project-note').parent, sourceUuid('weekly-project'));
  assert.equal([...graph.pages.values()].filter(p => p.kind === 'journal').length, 2);
  assert.ok(![...graph.pages.values()].some(p => p.kind === 'calendar-period' || p.name === 'Calendar'));
  assert.ok(new NativeScope(graph).candidates(['and', [['tag', 'tag-book'], ['ref', 'Work Space']]]).has(sourceUuid('weekly-project')));
});

test('month and year notes join January 1 while root-workspace notes remain at journal root', () => {
  const exports = fixture();
  for (const workspaceName of ['Root', 'Work']) {
    const data = exports[workspaceName], calendar = workspaceName === 'Root' ? 'calendar' : 'work-calendar';
    const year = workspaceName + '-year', month = workspaceName + '-month';
    record(data, calendar).children.push(year);
    data.docs.push(node(year, '2025', {kind:'journalPart',owner:calendar,children:[month,year+'-note']}),
      node(month,'2025-01',{kind:'journalPart',owner:year,children:[month+'-note']}),
      node(year+'-note','Annual note',{owner:year}),node(month+'-note','Monthly note',{owner:month}));
  }
  const graph = convert(exports), journal = graph.dayPage('2025-01-01');
  assert.deepEqual(journal.blocks.filter(b=>b.sourceId?.startsWith('Root-')).map(b=>b.sourceId).sort(),['Root-month-note','Root-year-note']);
  const groups = journal.blocks.filter(b=>b.text==='[[Work Space]]');
  assert.equal(groups.length,1);
  assert.deepEqual(groups[0].children.map(b=>b.sourceId).sort(),['Work-month-note','Work-year-note']);
  assert.ok(![...graph.pages.values()].some(p=>p.name==='2025'||p.name==='2025-01'||p.name==='Calendar'));
});

test('references to empty periods resolve without materializing unrelated empty weeks or years', () => {
  const exports=fixture();
  exports.Work.docs.push(node('empty-period','2025-02',{kind:'journalPart',owner:'work-calendar'}),
    node('unused-period','2026',{kind:'journalPart',owner:'work-calendar'}));
  record(exports.Work,'work-calendar').children.push('empty-period','unused-period');
  record(exports.Root,'daily').props.name += ' <span data-inlineref-node="empty-period"></span>';
  const graph=convert(exports),expected=blocks(graph);
  assert.ok(graph.pages.has('journal:2025-02-01'));
  assert.ok(!graph.pages.has('journal:2026-01-01'));
  const group=graph.dayPage('2025-02-01').blocks[0];
  assert.equal(group.text,'[[Work Space]]');
  assert.ok(expected.find(b=>b.source_id==='daily').text.includes('(('+group.uuid+'))'));
  graph.validateIds();
});

test('period properties and descriptions survive their move to a daily journal', () => {
  const exports=fixture();
  exports.Work.docs.push(node('month','2025-02',{kind:'journalPart',owner:'work-calendar',description:'Planning notes'}));
  record(exports.Work,'work-calendar').children.push('month');
  fieldValue(exports,'month','rating','Rating','4');
  const graph=convert(exports),month=blocks(graph).find(b=>b.source_id==='month');
  assert.equal(month.path,'journals/2025_02_01.md');
  assert.equal(month.properties.rating,'4');
  assert.equal(graph.dayPage('2025-02-01').blocks[0].children[0].children[0].text,'Planning notes');
});

test('excluding a calendar supertag does not leave empty period labels or journals', async () => {
  const exports=fixture();
  exports.Shared.docs.push(node('week-tag','Week',{kind:'tagDef',owner:'s-home'}));
  exports.Work.docs.push(node('month','2025-02',{kind:'journalPart',owner:'work-calendar'}));
  record(exports.Work,'work-calendar').children.push('month');
  addTags(exports.Work,'month','week-tag');
  const graph=convert(exports);
  assert.ok(graph.pages.has('journal:2025-02-01'));
  const audit=await applyImportDecisions(graph,{exclude_pages:['week-tag']},2);
  assert.ok(!graph.pages.has('journal:2025-02-01'));
  assert.ok(audit.calendar_cleanup.removed_pages.includes('journals/2025_02_01.md'));
  assert.ok(!blocks(graph).some(b=>b.source_id==='month'));
  graph.validateIds();
});

function addTags(exportData, identity, ...tags) {
  const meta = `${identity}-test-meta`;
  const assignment = `${identity}-test-tags`;
  record(exportData, identity).props._metaNodeId = meta;
  exportData.docs.push(node(meta, "", { kind: "metanode", owner: identity, children: [assignment] }),
    node(assignment, "", { kind: "tuple", owner: meta, children: ["SYS_A13", ...tags] }));
}

test("import decisions merge typed fields and tag pages while excluding only selected definitions", async () => {
  const exports = fixture();
  exports.Shared.docs.push(
    node("rating-peer", "Rating", {kind: "attrDef", owner: "s-home"}),
    node("old-field", "Old field", {kind: "attrDef", owner: "s-home"}),
    node("old-tag", "Old tag", {kind: "tagDef", owner: "s-home"}),
  );
  record(exports.Shared, "s-home").children.push("rating-peer", "old-field", "old-tag");
  record(exports.Root, "daily").children.push("peer-value");
  exports.Root.docs.push(node("peer-value", "", {kind: "tuple", owner: "daily", children: ["rating-peer", "peer-number"]}),
    node("peer-number", "12 hours", {owner: "peer-value"}));
  addTags(exports.Root, "daily", "old-tag");
  const graph = convert(exports), originalIds = new Set(blocks(graph).map(b => b.uuid));
  const audit = await applyImportDecisions(graph, {
    fields: [{sources: ["rating", "rating-peer"], key: "rating", query_type: "text"}],
    pages: [{sources: ["tag-book", "book"], name: "Book"}],
    exclude_fields: ["old-field"], exclude_pages: ["old-tag"],
  }, 2);
  assert.equal(graph.pageFor.get("book"), graph.pageFor.get("tag-book"));
  assert.equal(graph.fields.get("rating-peer").key, "rating");
  assert.equal(graph.fields.get("rating").query_type, "text");
  assert.equal(graph.fields.get("rating").sheet_type, "number");
  assert.ok(blocks(graph).some(b => b.properties.rating === "12 hours"));
  assert.ok(blocks(graph).some(b => b.properties.rating === "0"));
  assert.ok(blocks(graph).some(b => b.source_id === "daily"));
  assert.ok(!blocks(graph).some(b => b.text.includes("#[[Old tag]]")));
  assert.ok(blocks(graph).every(b => originalIds.has(b.uuid)));
  assert.equal(originalIds.size - blocks(graph).length, audit.removed_block_ids.length);
  const manifest = graph.manifest(blocks(graph), {});
  recordImportDecisions(manifest, graph);
  assert.equal(manifest.nodes["old-field"].status, "excluded-by-decision");
  assert.equal(manifest.nodes["old-tag"].status, "excluded-by-decision");
  assert.equal(manifest.fields["rating-peer"].page, "rating");
});

test("import decisions refuse conflicting values and duplicate page targets", async () => {
  const exports = fixture();
  exports.Shared.docs.push(node("rating-peer", "Rating", {kind: "attrDef", owner: "s-home"}));
  record(exports.Root, "book").children.push("second-rating");
  exports.Root.docs.push(node("second-rating", "", {kind: "tuple", owner: "book", children: ["rating-peer", "second-number"]}),
    node("second-number", "2", {owner: "second-rating"}));
  await assert.rejects(applyImportDecisions(convert(exports), {
    fields: [{sources: ["rating", "rating-peer"], key: "rating", query_type: "text"}],
  }, 1), /Conflicting properties/);
  await assert.rejects(applyImportDecisions(convert(), {
    pages: [{sources: ["book"], name: "Book"}],
  }, 1), /collides/);
});

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

  test("query definitions and cached results stay outside graph content", () => {
    const query = queryFor(graph, "query");
    assert.equal(query.status, "translated");
    assert.ok(query.expression.includes("tag('Record')"));
    assert.deepEqual(query.result_ids, ["book"]);
    assert.ok(graph.definitions.has(query.source_definition_path));
    assert.ok(!expected.some(block => block.text === "Exported results" || block.text.includes("Original search and view definition")));
    assert.ok(![...graph.pages.values()].some(page => page.name.startsWith("Tana import")));
  });

  test("notes authored inside a search survive without a results wrapper", () => {
    const exports = fixture();
    exports.Root.docs.push(node("inside-search", "An authored note", {owner: "query"}));
    record(exports.Root, "query").children.push("inside-search");
    const converted = convert(exports), result = blocks(converted);
    assert.equal(result.filter(block => block.source_id === "inside-search").length, 1);
    assert.equal(result.find(block => block.source_id === "inside-search").parent, sourceUuid("query"));
    assert.deepEqual(queryFor(converted, "query").result_ids, ["book", "inside-search"]);
  });

  test("authored workspace metadata and directly referenced workspace anchors survive", () => {
    for (const mode of ["description", "reference"]) {
      const exports = fixture();
      if (mode === "description") record(exports.Root, "r-home").props.description = "Authored workspace note";
      else record(exports.Root, "daily").props.name += ' <span data-inlineref-node="r-home">Root</span>';
      const converted = convert(exports), result = blocks(converted);
      assert.equal(result.filter(block => block.source_id === "r-home").length, 1);
      assert.equal(converted.recoveredPage.name, "Recovered notes");
      if (mode === "description") assert.ok(result.some(block => block.text === "Authored workspace note"));
    }
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

  test("cached query results do not restore archived tag matches", () => {
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
    assert.equal(query.expression, "@block and (tag('Record'))");
    assert.ok(!converted.emitted.has("archived"));
    assert.ok(query.result_ids.includes("archived"));
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
    assert.ok(converted.recoveredPage.blocks.some((block) => block.sourceId === "book"));
    assert.ok(!converted.emitted.has("archived"));
  });

  test("explicitly referenced archived notes remain ordinary queryable notes", () => {
    const exports = fixture();
    exports.Root.docs.push(node("r-root_TRASH", "", {owner: "r-root"}), node("archived", "Referenced book", {owner: "r-root_TRASH"}));
    addTags(exports.Root, "archived", "tag-book");
    record(exports.Root, "daily").props.name += ' <span data-inlineref-node="archived">Book</span>';
    const converted = convert(exports), query = queryFor(converted, "query");
    assert.equal(query.status, "translated");
    assert.equal(query.scope_validation.candidate_count, 2);
    assert.equal(query.expression, "@block and (tag('Record'))");
    assert.ok(converted.recoveredPage.blocks.some(block => block.sourceId === "archived"));
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
    graph.pageFor.get("book").blocks.push(graph.generated("generated-rating", "Summary", { rating: "1" }));
    assert.throws(() => new NativeScope(graph).validate(compiler.scope), /generated/);
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
