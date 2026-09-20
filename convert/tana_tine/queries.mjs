/** Conservative TQL translation: an unknown clause preserves the whole query. */

import { datesIn, isoDay, pageIdentity } from "./model.mjs";

export class UnsupportedQuery extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedQuery";
  }
}

export function quoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function prop(key) {
  return `prop(${quoted(key)})`;
}

function combine(operator, branches) {
  const items = [...branches];
  if (!items.length) throw new UnsupportedQuery("Empty Boolean expression");
  return `(${items.join(` ${operator} `)})`;
}

function addMember(index, key, identity) {
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(identity);
}

function intersection(left, right) {
  return new Set([...left].filter((identity) => right.has(identity)));
}

function difference(left, right) {
  return new Set([...left].filter((identity) => !right.has(identity)));
}

/** Candidate bounds, never a substitute TQL evaluator. Positive native facets
 * bound imported rows; unbounded or generated matches require a snapshot. */
export class NativeScope {
  constructor(graph) {
    this.sourceBlocks = new Set();
    this.tags = new Map();
    this.properties = new Map();
    this.references = new Map();
    this.tasks = new Set();

    const walk = (block, inheritedRefs) => {
      const identity = block.uuid;
      // A source note explicitly retained through a live reference is ordinary
      // graph content, even if Tana had archived it. No Tana activity predicate
      // belongs in the user's native queries.
      if (block.sourceId && graph.source.nodes.has(block.sourceId)) this.sourceBlocks.add(identity);
      for (const tag of graph.nativeTags.get(identity) ?? []) addMember(this.tags, tag, identity);
      const references = new Set(inheritedRefs);
      // These scans deliberately include code/escaped links: overapproximation
      // can disable a query, but cannot silently widen its native result scope.
      for (const value of [block.text, ...Object.values(block.properties)]) {
        for (const match of value.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) references.add(pageIdentity(match[1]));
        for (const match of value.matchAll(/#([\p{L}\p{N}_./-]+)/gu)) references.add(pageIdentity(match[1]));
      }
      for (const name of references) addMember(this.references, name, identity);
      for (const key of Object.keys(block.properties)) addMember(this.properties, key, identity);
      // Overapproximate markers in headings/code for the same conservative bound.
      if (!block.text.startsWith("{{tine-query ")
          && /(?<![\p{L}\p{N}_-])(?:TODO|DOING|DONE|NOW|LATER|WAITING|WAIT|CANCELED|CANCELLED|STARTED|IN-PROGRESS)(?![\p{L}\p{N}_-])/u.test(block.text)) {
        this.tasks.add(identity);
      }
      for (const child of block.children) walk(child, references);
    };

    for (const page of graph.pages.values()) {
      for (const block of page.blocks) walk(block, new Set([pageIdentity(page.name)]));
    }
  }

  candidates(scope) {
    if (scope === null) return null;
    const [kind, values] = scope;
    if (kind === "tag") return this.tags.get(values) ?? new Set();
    if (kind === "property") return this.properties.get(values) ?? new Set();
    if (kind === "task") return this.tasks;
    if (kind === "ref") return this.references.get(pageIdentity(values)) ?? new Set();
    const domains = values.map((value) => this.candidates(value));
    if (kind === "or") {
      return domains.some((domain) => domain === null) ? null : new Set(domains.flatMap((domain) => [...domain]));
    }
    const bounded = domains.filter((domain) => domain !== null);
    return bounded.length ? bounded.slice(1).reduce(intersection, new Set(bounded[0])) : null;
  }

  validate(scope) {
    const candidates = this.candidates(scope);
    if (candidates === null) {
      throw new UnsupportedQuery("Query has no positive tag, task, authored-field, or page-reference scope; native search would include generated content");
    }
    const unintended = difference(candidates, this.sourceBlocks);
    if (unintended.size) {
      throw new UnsupportedQuery(`Native predicates may also match ${unintended.size} missing or generated blocks`);
    }
    const result = {
      method: "conservative-native-candidate-bound", candidate_count: candidates.size,
      non_source_candidates: 0,
    };
    return result;
  }
}

export class Compiler {
  constructor(converter, context) {
    this.graph = converter;
    this.source = converter.source;
    this.context = context;
    this.stack = new Set();
    this.scope = null;
    this.adaptations = new Map();
  }

  value(field, identity) {
    const descriptor = this.graph.fields.get(field);
    const name = this.graph.plain(identity).trim();
    const type = descriptor.query_type.replace(/^list of /, "");
    if (type === "date") {
      const dates = datesIn(this.source.name(identity));
      if (dates.length === 1 && isoDay(dates[0].dateTimeString)) return quoted(dates[0].dateTimeString);
      if (["TODAY", "FOR RELATIVE DATE TODAY", "FOR RELATIVE DATE +0"].includes(name.toUpperCase())) return "today";
      if (name.toUpperCase() === "PARENT") {
        const day = this.source.dayContext(this.context);
        if (day) return quoted(day);
      }
      throw new UnsupportedQuery(`Date operand has unsupported relative/range semantics: ${name}`);
    }
    const converted = this.graph.scalarValue(field, identity);
    if (converted === null) throw new UnsupportedQuery(`Query operand is not a supported scalar: ${identity}`);
    if (converted === "") return "''";
    if (type === "number" || type === "checkbox") return converted;
    if (converted.startsWith("[[") && converted.endsWith("]]")) return quoted(converted.slice(2, -2));
    return quoted(converted);
  }

  field(field, values, operator = "=") {
    const descriptor = this.graph.fields.get(field);
    if (!descriptor.query_safe) throw new UnsupportedQuery(`Field contains rich or non-atom-safe values: ${descriptor.source_name}`);
    const target = prop(descriptor.key);
    if (operator !== "=" && (!values.length || values.some((value) => ["SYS_V59", "SYS_V60"].includes(value)))) {
      throw new UnsupportedQuery("Ordered comparison requires a value, not a field-presence condition");
    }
    if (!values.length) return `${target} is not null`;
    if (values.length === 1 && values[0] === "SYS_V60") return `(${target} is not null and not (${target} = ''))`;
    if (values.length === 1 && values[0] === "SYS_V59") return `(${target} is null or ${target} = '')`;
    if (values.length > 1) return combine("or", values.map((value) => this.field(field, [value], operator)));
    const identity = values[0];
    if (this.source.kind(identity) === "tuple") {
      const operands = this.source.children(identity);
      if (operands.length && ["SYS_A48", "SYS_A49"].includes(operands[0])) {
        return this.field(field, operands.slice(1), operands[0] === "SYS_A48" ? ">" : "<");
      }
      throw new UnsupportedQuery(`Unsupported field operand tuple: ${identity}`);
    }
    const type = descriptor.query_type.replace(/^list of /, "");
    if (operator !== "=" && !["date", "number"].includes(type)) {
      throw new UnsupportedQuery("Ordered comparison requires a preserved number/date field");
    }
    const value = this.value(field, identity);
    if (type === "checkbox" && value === "false") {
      const stored = (this.graph.fieldAssignments.get(field) ?? [])
        .filter(([owner]) => !this.graph.tags.has(owner) && !this.graph.fields.has(owner))
        .flatMap(([, items]) => items);
      if (!stored.some((item) => ["true", "false"].includes(this.graph.scalarValue(field, item)))) {
        throw new UnsupportedQuery("Checkbox false query has no exported stored values; missing/unchecked or computed-default semantics cannot be established");
      }
    }
    return `${target} ${operator} ${value}`;
  }

  predicate(identity) {
    if (this.stack.has(identity)) throw new UnsupportedQuery(`Cyclic search expression: ${identity}`);
    this.stack.add(identity);
    try {
      return this.compilePredicate(identity);
    } finally {
      this.stack.delete(identity);
    }
  }

  compilePredicate(identity) {
    const source = this.source;
    if (!source.nodes.has(identity)) throw new UnsupportedQuery(`Missing search operand: ${identity}`);
    const name = this.graph.plain(identity).trim();
    const kind = source.kind(identity);
    if (this.graph.tags.has(identity)) return `tag(${quoted(this.graph.pageFor.get(identity).name)})`;
    if (identity === "SYS_T100") return "task is not null";
    if (kind === "home") {
      if (source.workspace.get(identity) === this.graph.rootWorkspace) {
        const pages = [...this.graph.pageFor].filter(([home, page]) => source.kind(home) === "home" && page.kind === "workspace")
          .map(([, page]) => page.name).sort();
        this.adaptations.set(identity, {
          source_home_id: identity, native_scope: "outside-named-workspaces", excluded_workspace_pages: pages,
          semantics: "The root workspace searches notes outside named workspace page/reference scopes",
        });
        return pages.length ? `not ${combine("or", pages.map((page) => `ref(${quoted(page)})`))}` : "true";
      }
      const page = this.graph.pageFor.get(identity);
      if (!page || page.kind !== "workspace") {
        throw new UnsupportedQuery("Flattened shared workspace has no named native page-reference scope");
      }
      this.adaptations.set(identity, {
        source_home_id: identity, native_page: page.name,
        semantics: "Native ref includes the owning page and explicit page references on the block or its ancestors",
      });
      return `ref(${quoted(page.name)})`;
    }
    if (this.graph.fields.has(identity)) return this.field(identity, []);
    if (kind === "tuple") {
      const operands = source.children(identity);
      if (!operands.length) throw new UnsupportedQuery("Empty expression tuple");
      const [head, ...values] = operands;
      if (["SYS_A41", "SYS_A42", "SYS_A43"].includes(head)) {
        const operator = head === "SYS_A42" ? "or" : "and";
        const result = combine(operator, values.map((value) => this.predicate(value)));
        return head === "SYS_A43" ? `not ${result}` : result;
      }
      if (this.graph.fields.has(head)) return this.field(head, values);
      if (["SYS_A48", "SYS_A49"].includes(head) && values.length === 1) {
        const child = source.children(values[0]);
        if (child.length && this.graph.fields.has(child[0])) return this.field(child[0], child.slice(1), head === "SYS_A48" ? ">" : "<");
      }
      if (["SYS_V49", "SYS_V53"].includes(head) && values.length) {
        const relationship = head === "SYS_V49" ? "LINKS TO" : "CHILD OF";
        throw new UnsupportedQuery(`${relationship} has no exact native predicate for original source links/placements`);
      }
      if (head === "SYS_A82" && values.length === 1) {
        throw new UnsupportedQuery("Source calendar context is not equivalent to a merged Tine journal page");
      }
      if (head === "SYS_203" && values.length === 1) {
        const nested = source.children(values[0]);
        if (nested.length && this.graph.fields.has(nested[0]) && this.graph.fields.get(nested[0]).query_type === "date") {
          return this.field(nested[0], nested.slice(1));
        }
      }
      throw new UnsupportedQuery(`Unsupported search operator: ${source.name(head) || head}`);
    }
    if (name === "DONE") return "task = 'DONE'";
    if (name === "NOT DONE") return "(task is not null and task not in ('DONE', 'CANCELED', 'CANCELLED'))";
    if (name === "ON DAY NODE") throw new UnsupportedQuery("Direct source day placement has no exact native predicate");
    if (name === "IS CALENDAR NODE") throw new UnsupportedQuery("Source calendar-node kind is not represented by a native block attribute");
    if (name === "IS SEARCH NODE") throw new UnsupportedQuery("Source search-node kind is not represented by a native block attribute");
    if (name === "ANY ACCESSIBLE WORKSPACE") return "true";
    if (["PARENT", "FOR RELATIVE DATE", "DONE LAST", "IS ", "HAS_", "FROM CALENDAR"].some((prefix) => name.startsWith(prefix))) {
      throw new UnsupportedQuery(`Unsupported contextual expression: ${name}`);
    }
    if (name && !source.children(identity).length) {
      // TQL MATCH is token search; Tana free text is substring matching.
      if (/[%_]/.test(name)) throw new UnsupportedQuery("Literal text search includes SQL wildcard characters");
      return `content like ${quoted(`%${name}%`)}`;
    }
    throw new UnsupportedQuery(`Unsupported search expression: ${identity}`);
  }

  compile(expressions) {
    if (!expressions.length) throw new UnsupportedQuery("No search expression was included in the export");
    const expression = `@block and ${combine("and", expressions.map((value) => this.predicate(value)))}`;
    this.scope = ["and", expressions.map((value) => this.candidateScope(value))];
    return expression;
  }

  candidateScope(identity) {
    if (this.graph.tags.has(identity)) return ["tag", identity];
    if (identity === "SYS_T100" || ["DONE", "NOT DONE"].includes(this.graph.plain(identity).trim())) return ["task", null];
    if (this.graph.fields.has(identity)) return ["property", this.graph.fields.get(identity).key];
    if (this.source.kind(identity) === "home") {
      return this.source.workspace.get(identity) === this.graph.rootWorkspace ? null : ["ref", this.graph.pageFor.get(identity).name];
    }
    if (this.source.kind(identity) === "tuple") {
      const [head, ...values] = this.source.children(identity);
      if (["SYS_A41", "SYS_A42"].includes(head)) {
        return [head === "SYS_A41" ? "and" : "or", values.map((value) => this.candidateScope(value))];
      }
      if (this.graph.fields.has(head) && !values.includes("SYS_V59")) return ["property", this.graph.fields.get(head).key];
      if (["SYS_A48", "SYS_A49", "SYS_203"].includes(head) && values.length === 1) return this.candidateScope(values[0]);
    }
    return null;
  }
}

export function viewSettings(graph, identity) {
  const source = graph.source;
  const builtinFields = new Map([["SYS_A13", ["tags", "tags"]]]);
  const fieldInfo = (sourceId) => {
    if (graph.fields.has(sourceId)) {
      const item = graph.fields.get(sourceId);
      return [item.key, item.sheet_type];
    }
    return builtinFields.get(sourceId);
  };
  const kind = source.props(identity)._view ?? "list";
  const props = {};
  const limitations = [];
  if (["table", "list"].includes(kind)) props["tine.view"] = kind;
  else if (kind === "navigationList") {
    props["tine.view"] = "list";
    limitations.push("Navigation behavior retained as an ordinary list");
  } else if (kind === "calendar") {
    props["tine.view"] = "table";
    limitations.push("Calendar layout retained as a table; date fields remain available");
  } else if (["cards", "tiles"].includes(kind)) {
    props["tine.view"] = "table";
    limitations.push("Card/tile layout retained as a table");
  } else limitations.push(`Unsupported view type: ${kind}`);

  const columns = [];
  const schemas = [];
  for (const column of source.setting(identity, "SYS_A17")) {
    const children = source.children(column);
    const field = children.length ? children[0] : column;
    const descriptor = fieldInfo(field);
    if (descriptor) {
      const [key, type] = descriptor;
      columns.push(key);
      schemas.push(`${key}=${type}`);
    } else if (field !== "SYS_A21") {
      // Source title is already the native first column.
      limitations.push(`Unsupported column: ${source.name(field) || field}`);
    }
  }
  if (columns.length) {
    props["tine.columns"] = [...new Set(columns)].join(";");
    props["tine.fields"] = [...new Set(schemas)].join(";");
    if (!props["tine.fields"]) delete props["tine.fields"];
  }
  const sorting = [];
  for (const rule of source.setting(identity, "SYS_A19")) {
    const children = source.children(rule);
    if (children.length >= 3 && children[0] === "SYS_A20" && fieldInfo(children[1])) {
      const direction = source.name(children[2]);
      if (["ASC", "DESC", "NUM_ASC", "NUM_DESC"].includes(direction)) {
        const [key, type] = fieldInfo(children[1]);
        if (direction.startsWith("NUM_") && type !== "number") limitations.push(`Numeric sort on a non-numeric field: ${key}`);
        else sorting.push(`${key}${direction.endsWith("ASC") ? " asc" : " desc"}`);
      } else limitations.push(`Unsupported sort direction: ${direction}`);
    } else limitations.push(`Unsupported sort definition: ${rule}`);
  }
  if (sorting.length) props["tine.sort"] = sorting.join(";");
  const groups = source.setting(identity, "SYS_A34")
    .filter((group) => source.name(group).trim() || source.children(group).length || source.tags(group).length);
  if (groups.length) {
    const fields = [];
    for (const group of groups) {
      const children = source.children(group);
      const head = children.length ? children[0] : group;
      const info = fieldInfo(head);
      if (info && !["SYS_A63", "SYS_A64"].includes(head)) {
        fields.push(info[0]);
        if (children.length > 1) limitations.push("Source group ordering/options retained in definition; Tine determines group order");
      } else limitations.push(`Unsupported grouping or time bucket: ${source.name(head) || head}`);
    }
    if (fields.length) props["tine.group-field"] = fields[0] === "tags" ? "tags" : `prop:${fields[0]}`;
    if (fields.length > 1 || groups.length > 1) limitations.push("Multiple or unsupported grouping definitions retained in the source archive");
  }
  const handled = new Set(["SYS_A15", "SYS_A17", "SYS_A19", "SYS_A34"]);
  for (const [, key] of source.tuples(identity)) {
    if (!handled.has(key)) limitations.push(`View setting retained in source: ${source.name(key) || key}`);
  }
  return [props, [...new Set(limitations)]];
}
