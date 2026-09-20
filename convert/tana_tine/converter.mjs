/** Merge workspace outlines into an ordinary, loss-aware Tine graph. */
import {decodeHTML} from 'entities';
import {Block, Page, Names, CONTENT_KINDS, METADATA_KINDS, datesIn, isoDay, calendarAnchor, journalTitle,
  safeProse, sourceUuid, stableUuid, appendTo, extend, unique, compare, countBy, pageProperties} from './model.mjs';
import {Compiler, NativeScope, UnsupportedQuery, viewSettings} from './queries.mjs';
import {RichText, codeFence, escapeSourceHashtags} from './richtext.mjs';

const TASK_MARKERS = new Set(['TODO', 'DOING', 'DONE', 'NOW', 'LATER', 'WAITING', 'WAIT', 'CANCELED', 'CANCELLED', 'STARTED', 'IN-PROGRESS']);
export const RESERVED_KEYS = new Set(['id', 'title', 'tags', 'alias', 'aliases', 'state', 'priority', 'scheduled', 'deadline', 'page', 'collapsed', 'public', 'heading', 'icon', 'file', 'template', 'filters', 'logseq.order-list-type']);
export const INTERNAL_KEYS = new Set(['hl-page', 'hl-color', 'hl-type', 'ls-type', 'background-color', 'template-including-parent']);
export function titleMatchesDay(value, day) {
  if (!day) return false;
  if (value.replaceAll('/', '-') === day) return true;
  // Some older imported journal titles use year/day/month. Only recognize the
  // unambiguous case; a plausible month must not be silently reinterpreted.
  const swapped = value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  return Boolean(swapped && Number(swapped[2]) > 12 && `${swapped[1]}-${swapped[3]}-${swapped[2]}` === day);
}
const has = (object, key) => Object.hasOwn(object, key);
const sorted = values => [...values].sort(compare);
function jsonText(value) {
  if (Array.isArray(value)) return '[' + value.map(jsonText).join(', ') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort(compare).map(key => JSON.stringify(key) + ': ' + jsonText(value[key])).join(', ') + '}';
  return JSON.stringify(value);
}
export function validateFieldNames(source, overrides) {
  const normalized = new Map();
  for (const [identity, key] of Object.entries(overrides)) {
    if (!source.nodes.has(identity) || identity.startsWith('SYS_') || !source.active(identity)
      || !(source.kind(identity) === 'attrDef' || source.tags(identity).includes('SYS_T02'))) throw new Error('Unknown source field ID in field-name override: ' + identity);
    if (typeof key !== 'string') throw new Error('Field-name override must be a string: ' + identity);
    const canonical = key.trim().toLowerCase().replaceAll('_', '-').replaceAll(' ', '-').normalize('NFC');
    if (normalized.has(canonical)) throw new Error('Field-name overrides collide after normalization: ' + normalized.get(canonical) + ' and ' + identity);
    normalized.set(canonical, identity);
  }
  for (const [canonical, identity] of normalized) {
    const key = overrides[identity];
    if (!key || key.startsWith('/') || key.endsWith('/') || !/^[\p{L}\p{M}\p{N}./-]+$/u.test(key)) throw new Error('Unsafe field-name override for ' + identity + ': ' + JSON.stringify(key));
    if (key !== canonical) throw new Error('Field-name override must already be normalized lowercase: ' + JSON.stringify(key));
    if (RESERVED_KEYS.has(key) || INTERNAL_KEYS.has(key) || /^(?:tine|logseq)[.-]/.test(key)) throw new Error('Reserved native property name in field-name override: ' + key);
  }
}
export function allocateFieldKey(base, identity, used) {
  if (!used.has(base)) return base;
  const suffix = sourceUuid(identity).replaceAll('-', '');
  for (let length = 8; length <= 32; length += 4) {
    const key = base + '-' + suffix.slice(0, length);
    if (!used.has(key)) return key;
  }
  throw new Error('Cannot allocate a unique property key for source field ' + identity);
}
export function keyName(name, identity) {
  let text = name.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!text) text = 'field-' + sourceUuid(identity).slice(0, 8);
  if (RESERVED_KEYS.has(text) || /^(?:tine|logseq)-/.test(text)) text = 'source-' + text;
  return text;
}
/** Expand decimal notation without rounding through binary floating point. */
export function decimalNumber(value) {
  const input = value.trim();
  const match = input.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new RangeError('Not a finite decimal');
  if (!Number.isFinite(Number(input))) throw new RangeError("Number is outside Tine's finite range");
  const sign = match[1] === '-' ? '-' : '';
  const fraction = match[3] ?? match[4] ?? '';
  let digits = ((match[2] ?? '0') + fraction).replace(/^0+(?=\d)/, '');
  const scale = fraction.length - Number(match[5] ?? 0);
  if (scale <= 0) return sign + (/^0+$/.test(digits) ? '0' : digits + '0'.repeat(-scale));
  digits = digits.padStart(scale + 1, '0');
  return sign + digits.slice(0, -scale) + '.' + digits.slice(-scale);
}

export class Converter {
  constructor(source, {rootWorkspace = null, sharedWorkspaces = [], workspaceTitles = {}, fieldNames = {}, assets = {}} = {}) {
    this.source = source;
    this.rootWorkspace = rootWorkspace;
    this.sharedWorkspaces = new Set(sharedWorkspaces);
    this.workspaceTitles = workspaceTitles;
    this.assets = assets;
    const unknown = unique([...(rootWorkspace ? [rootWorkspace] : []), ...sharedWorkspaces, ...Object.keys(workspaceTitles)]).filter(name => !source.homes.has(name));
    if (unknown.length) throw new Error('Unknown workspace role/title: ' + sorted(unknown).join(', '));
    if (this.sharedWorkspaces.has(rootWorkspace)) throw new Error('A workspace cannot have both root and shared roles');
    this.fieldNames = {...fieldNames};
    validateFieldNames(source, this.fieldNames);
    this.names = new Names();
    for (const key of ['pages', 'pageFor', 'refs', 'fields', 'fieldUses', 'fieldAssignments', 'scalarIds', 'plainCache', 'tagCache', 'occurrences', 'definitions', 'nativeTags', 'daySources', 'dayGroups', 'representations', 'legacyBlockIds', 'periodAnchors']) this[key] = new Map();
    for (const key of ['tags', 'emitted', 'required', 'plainStack', 'nativeValues', 'calendarNavigation', 'journalGroupIds']) this[key] = new Set();
    this.issues = [];
    this.queries = [];
    this.nativeQueries = [];
    this.queryTargets = [];
    this.viewTargets = [];
    this.queriesProcessed = 0;
    this.viewsProcessed = 0;
    this.uuidSources = new Map([...source.nodes.keys()].map(identity => [sourceUuid(identity), identity]));
    this.recoveredPage = null;
    // Flattened workspace navigation is temporary bookkeeping, not a graph page.
    this.index = new Page('', '', 'workspace-navigation');
  }
  issue(code, identity = null, details = {}) { this.issues.push({code, source_id: identity, ...details}); }
  newPage(identity, name, kind, sourceId = null) {
    const [title, path] = this.names.allocate(name, identity);
    const page = new Page(title, path, kind, sourceId ? [sourceId] : []);
    this.pages.set(identity, page);
    if (sourceId) {
      this.pageFor.set(sourceId, page);
      this.refs.set(sourceId, {type: 'page', target: title});
    }
    return page;
  }
  dayPage(day) {
    const identity = 'journal:' + day;
    if (!this.pages.has(identity)) {
      const title = journalTitle(day);
      const [name] = this.names.allocate(title, identity);
      if (name !== title) throw new Error('A generated page collides with journal title ' + title);
      this.pages.set(identity, new Page(title, 'journals/' + day.replaceAll('-', '_') + '.md', 'journal'));
    }
    return this.pages.get(identity);
  }
  plain(identity) {
    if (this.plainCache.has(identity)) return this.plainCache.get(identity);
    if (this.plainStack.has(identity)) return 'Tana node ' + identity;
    this.plainStack.add(identity);
    try {
      const text = new RichText(this.reference.bind(this), this.dateReference.bind(this), {plain: true}).convert(this.source.name(identity)).trim();
      this.plainCache.set(identity, text);
      return text;
    } finally { this.plainStack.delete(identity); }
  }
  reference(identity, plain = false) {
    if (plain) return this.source.nodes.has(identity) ? this.plain(identity) : 'Unavailable Tana node ' + identity;
    this.required.add(identity);
    const target = this.refs.get(identity);
    return target?.type === 'page' ? '[[' + target.target + ']]' : '((' + (target?.target ?? sourceUuid(identity)) + '))';
  }
  dateReference(date, plain = false) {
    const value = date.dateTimeString;
    if (typeof value !== 'string') throw new Error('Inline date has no dateTimeString');
    if (plain) return value;
    if (/^\d{4}(?:-\d{2}|-W\d{2})?$/.test(value)) {
      const day = calendarAnchor(value);
      const reference = this.dateReference({...date, dateTimeString: day});
      return reference.replace(/^(\[\[[^\]]+\]\])/, target => '[' + value + '](' + target + ')');
    }
    const extras = Object.fromEntries(Object.entries(date).filter(([key]) => key !== 'dateTimeString'));
    const endpoints = value.split('/').map(part => part.match(/^(\d{4}-\d{2}-\d{2})(?:T((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?))?$/));
    if (endpoints.length <= 2 && endpoints.every(Boolean)) {
      const timed = endpoints.some(endpoint => endpoint[2]);
      const rendered = endpoints.map(([, day, time]) => '[[' + this.dayPage(isoDay(day)).name + ']]' + (time ? ' ' + time : '')).join(' – ');
      // An all-day date already names its local day; do not shift it through UTC.
      // Timed references retain their exact clock precision, offset and timezone.
      const zones = unique(['timezone', 'timeZone'].filter(key => typeof extras[key] === 'string').map(key => {
        const zone = extras[key]; delete extras[key]; return zone;
      }));
      if (typeof extras.hasTime === 'boolean' && extras.hasTime === timed) delete extras.hasTime;
      return rendered + (timed && zones.length ? ' (' + zones.join(', ') + ')' : '')
        + (Object.keys(extras).length ? ' (' + jsonText(extras) + ')' : '');
    }
    return value + (Object.keys(extras).length ? ' (' + jsonText(extras) + ')' : '');
  }
  assetReference(target, label, image = false) {
    const decoded = decodeHTML(target);
    const entry = has(this.assets, decoded) ? this.assets[decoded] : null;
    if (entry && ['copied', 'downloaded', 'available'].includes(entry.status)) {
      target = '../' + entry.path;
      image ||= (entry.content_type ?? '').startsWith('image/');
    } else image ||= /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i.test(target);
    label = label.replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('\n', ' ');
    return (image ? '!' : '') + '[' + (label || 'Attachment') + '](<' + target.replaceAll('>', '%3E').replaceAll('\n', '%0A') + '>)';
  }
  rewriteAssets(value) {
    const result = value.replace(/(?<code>`{3,}[\s\S]*?`{3,}|`[^`\n]*`)|(?<image>!)?\[(?<label>(?:\\.|[^\]])*)\]\(<?(?<target>[^<>\n]*?)>?\)/g, (...args) => {
      const match = args.at(-1);
      if (match.code || !has(this.assets, match.target)) return args[0];
      return this.assetReference(match.target, match.label, Boolean(match.image));
    });
    return result.replace(/(?<code>`{3,}[\s\S]*?`{3,}|`[^`\n]*`)|(?<url>https?:\/\/[^\s<>"\)]+)/g, (...args) => {
      const match = args.at(-1);
      return !match.code && has(this.assets, match.url) && ['copied', 'downloaded', 'available'].includes(this.assets[match.url].status)
        ? this.assetReference(match.url, 'Attachment') : args[0];
    });
  }
  rich(value) {
    const text = this.rewriteAssets(new RichText(this.reference.bind(this), this.dateReference.bind(this), {assetReference: this.assetReference.bind(this)}).convert(value));
    const rewritten = text.replace(/(?<code>`{3,}[\s\S]*?`{3,}|`[^`\n]*`)|\(\((?<uuid>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)/g, (...args) => {
      const match = args.at(-1);
      if (match.code) return args[0];
      const uuid = match.uuid.toLowerCase();
      if (this.journalGroupIds.has(uuid)) return args[0];
      return this.reference(this.legacyBlockIds.get(uuid) ?? this.uuidSources.get(uuid) ?? uuid);
    });
    return escapeSourceHashtags(safeProse(rewritten));
  }
  title(identity) {
    const source = this.source;
    if (source.kind(identity) === 'codeblock') {
      const languages = source.setting(identity, 'SYS_A70');
      return codeFence(source.name(identity), languages.length ? this.plain(languages[0]).toLowerCase() : '');
    }
    let text = this.rich(source.name(identity));
    if (source.kind(identity) === 'url') {
      const targets = source.setting(identity, 'SYS_A78');
      if (targets.length === 1) text = this.assetReference(decodeHTML(source.name(targets[0])), text || this.plain(targets[0]));
    }
    const attachments = source.setting(identity, 'SYS_T15', {meta: true});
    if (attachments.length) {
      const links = attachments.map(target => this.assetReference(decodeHTML(source.name(target)), this.plain(identity) || 'Attachment', source.kind(identity) === 'visual'));
      text = [...(text && source.kind(identity) !== 'visual' ? [text] : []), ...links].join(' ');
    } else if (source.kind(identity) === 'visual') this.issue('attachment-without-source-url', identity);
    return text;
  }
  expandedTags(identity, stack = []) {
    if (this.tagCache.has(identity)) return this.tagCache.get(identity);
    if (stack.includes(identity)) throw new Error('Cyclic supertag inheritance: ' + [...stack, identity].join(' -> '));
    const result = [];
    for (const tag of this.source.tags(identity)) {
      if (this.tags.has(tag)) extend(result, [tag, ...this.expandedTags(tag, [...stack, identity])]);
    }
    this.tagCache.set(identity, unique(result));
    return this.tagCache.get(identity);
  }
  prepare() {
    const source = this.source;
    const active = [...source.nodes.keys()].filter(identity => !identity.startsWith('SYS_') && source.active(identity));
    for (const identity of active) {
      if (source.kind(identity) !== 'tuple') continue;
      const children = source.children(identity);
      if (children.length !== 2 || this.plain(children[0]).toLowerCase() !== 'id') continue;
      const value = this.plain(children[1]).toLowerCase();
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) {
        const owner = source.props(identity)._ownerId;
        if (this.legacyBlockIds.has(value) && this.legacyBlockIds.get(value) !== owner) throw new Error('Ambiguous source block identity: ' + value);
        this.legacyBlockIds.set(value, owner);
      }
    }
    const fieldIds = sorted(active.filter(identity => source.kind(identity) === 'attrDef' || source.tags(identity).includes('SYS_T02')));
    this.tags = new Set(active.filter(identity => source.kind(identity) === 'tagDef' || source.tags(identity).includes('SYS_T01')));
    const bases = new Map(fieldIds.map(identity => [identity, keyName(this.plain(identity), identity)]));
    const defaults = new Map();
    let used = new Set();
    for (const identity of fieldIds) {
      defaults.set(identity, allocateFieldKey(bases.get(identity), identity, used));
      used.add(defaults.get(identity));
    }
    const keys = new Map(Object.entries(this.fieldNames));
    used = new Set(keys.values());
    for (const identity of fieldIds) {
      if (!keys.has(identity) && !used.has(defaults.get(identity))) {
        keys.set(identity, defaults.get(identity));
        used.add(keys.get(identity));
      }
    }
    for (const identity of fieldIds) {
      if (!keys.has(identity)) {
        keys.set(identity, allocateFieldKey(bases.get(identity), identity, used));
        used.add(keys.get(identity));
      }
      const key = keys.get(identity);
      if (!has(this.fieldNames, identity) && key !== bases.get(identity)) this.issue('field-key-collision-disambiguated', identity, {key});
      const page = this.newPage(identity, key, 'property', identity);
      this.fields.set(identity, {key, source_name: this.plain(identity), query_type: 'text', sheet_type: 'text', query_safe: true,
        declared_type: '', options: [], many: false, page: page.name});
    }
    for (const identity of sorted([...this.tags].filter(tag => !this.fields.has(tag)))) this.newPage(identity, this.plain(identity), 'tag', identity);
    for (const identity of active) {
      if (source.kind(identity) !== 'journalPart') continue;
      const period = source.calendarDate(identity), day = calendarAnchor(period);
      if (!day) throw new Error('Unrecognized source calendar period: ' + identity);
      this.periodAnchors.set(identity, day);
      if (isoDay(period)) {
        const page = this.dayPage(day);
        page.sourceIds.push(identity);
        appendTo(this.daySources, day, [identity]);
      }
      const workspace = source.workspace.get(identity);
      this.refs.set(identity, workspace === this.rootWorkspace ? {type: 'page', target: journalTitle(day)}
        : {type: 'block', target: stableUuid('journal-group:' + source.roots.get(workspace) + ':' + day)});
      if (workspace !== this.rootWorkspace) this.journalGroupIds.add(this.refs.get(identity).target);
    }
    for (const [workspace, home] of source.homes) {
      const root = source.roots.get(workspace);
      const flattened = workspace === this.rootWorkspace || this.sharedWorkspaces.has(workspace);
      if (!flattened) {
        this.newPage(home, has(this.workspaceTitles, workspace) ? this.workspaceTitles[workspace] : (this.plain(home) || workspace), 'workspace', home);
        this.refs.set(root, this.refs.get(home));
      } else {
        this.refs.set(home, {type: 'block', target: sourceUuid(home)});
        this.refs.set(root, this.refs.get(home));
        for (const identity of [...source.children(home), ...source.children(root + '_STASH')]) {
          if (!this.pageFor.has(identity) && !['tuple', 'journal', 'journalPart'].includes(source.kind(identity))) this.newPage(identity, this.plain(identity), 'root', identity);
        }
      }
      for (const container of [root + '_SEARCHES', root + '_CAPTURE_INBOX', root + '_SCHEMA']) {
        for (const identity of source.children(container)) {
          if (!this.pageFor.has(identity) && CONTENT_KINDS.has(source.kind(identity)) && flattened) this.newPage(identity, this.plain(identity), 'root', identity);
        }
      }
    }
    const owners = new Map();
    for (const identity of active) {
      if (source.kind(identity) !== 'tuple' || source.lineage(identity).slice(1).some(ancestor => METADATA_KINDS.has(source.kind(ancestor)))) continue;
      const [field, ...values] = source.children(identity);
      if (!this.fields.has(field)) continue;
      appendTo(this.fieldUses, field, values);
      const owner = source.props(identity)._ownerId;
      appendTo(this.fieldAssignments, field, [[owner, values]]);
      if (!owners.has(owner)) owners.set(owner, new Map());
      owners.get(owner).set(field, (owners.get(owner).get(field) ?? 0) + values.length);
    }
    for (const counts of owners.values()) for (const [identity, count] of counts) this.fields.get(identity).many ||= count > 1;
    for (const [identity, descriptor] of this.fields) {
      const declared = source.setting(identity, 'SYS_T06');
      descriptor.declared_type = declared.length ? this.plain(declared[0]) : 'Plain';
      descriptor.options = source.setting(identity, 'SYS_T03');
      const uses = this.fieldUses.get(identity) ?? [];
      let type = new Map([['Number', 'number'], ['Date', 'date'], ['Checkbox', 'checkbox'], ['Options from supertag', 'ref']]).get(descriptor.declared_type) ?? 'text';
      if (type === 'ref' && uses.some(value => !this.pageFor.has(value))) {
        type = 'text';
        descriptor.block_references = true;
        this.issue('block-relationship-stored-as-text-reference', identity);
      }
      if (type === 'text' && uses.length && uses.every(value => this.pageFor.has(value))) type = 'ref';
      descriptor.query_type = descriptor.sheet_type = type;
      const invalid = unique(uses).filter(value => this.tryScalar(identity, value) === null);
      if (invalid.length) {
        descriptor.query_safe = false;
        if (['number', 'date', 'checkbox'].includes(type)) descriptor.query_type = descriptor.sheet_type = 'text';
        this.issue('field-values-require-content-preservation', identity, {values: invalid, declared_type: descriptor.declared_type});
      }
      const options = descriptor.options.map(option => this.plain(option));
      if (descriptor.declared_type === 'Options' && options.length && !descriptor.many
        && options.every(option => option && !/\[\[|\(\(|\{\{|[#`=;,\r\n]/.test(option))
        && new Set(options).size === options.length && uses.every(value => options.includes(this.plain(value)))) descriptor.sheet_type = 'enum:' + options.join(',');
      else if (descriptor.declared_type === 'Options' && options.length) this.issue('option-schema-retained-without-enum-enforcement', identity);
      if (descriptor.many) {
        descriptor.query_type = 'list of ' + descriptor.query_type;
        descriptor.sheet_type = type === 'text' && descriptor.query_safe ? 'list' : 'text';
      }
      this.pageFor.get(identity).properties['tine.type'] = descriptor.query_type;
    }
    for (const identity of this.tags) {
      this.expandedTags(identity);
      const fields = [];
      for (const tag of [identity, ...this.expandedTags(identity)]) {
        extend(fields, source.tuples(tag).map(([, key]) => key).filter(key => this.fields.has(key)));
        for (const value of source.setting(tag, 'SYS_A156', {meta: true})) extend(fields, source.children(value).slice(0, 1).filter(key => this.fields.has(key)));
      }
      if (fields.length) this.pageFor.get(identity).properties['tine.fields'] = unique(fields).map(key => this.fields.get(key).key + '=' + this.fields.get(key).sheet_type).join(';');
      const parents = source.tags(identity).filter(tag => this.tags.has(tag));
      if (parents.length) this.issue('supertag-inheritance-materialized', identity, {parents});
    }
  }
  scalarValue(field, identity) {
    const descriptor = this.fields.get(field), source = this.source;
    if (!source.nodes.has(identity)) return null;
    const type = descriptor.query_type.replace(/^list of /, '');
    let raw = source.name(identity), name = this.plain(identity);
    if (!raw.trim() && !source.children(identity).length && !source.tags(identity).length && !source.props(identity).description) return '';
    if (type === 'number') return source.children(identity).length || source.tags(identity).length ? null : decimalNumber(name);
    if (type === 'date') {
      const dates = datesIn(raw);
      return dates.length === 1 && Object.keys(dates[0]).every(key => key === 'dateTimeString') ? isoDay(dates[0].dateTimeString) : isoDay(name);
    }
    if (type === 'checkbox') {
      if (!['yes', 'no', 'true', 'false'].includes(name.toLowerCase())) return null;
      return ['yes', 'true'].includes(name.toLowerCase()) ? 'true' : 'false';
    }
    if (this.pageFor.has(identity) && !descriptor.options.includes(identity)) return '[[' + this.pageFor.get(identity).name + ']]';
    const owner = source.props(identity)._ownerId;
    if (!descriptor.options.includes(identity) && owner && source.kind(owner) !== 'tuple') return this.reference(identity);
    if (type === 'ref') return null;
    if (source.kind(identity) === 'url') {
      const targets = source.setting(identity, 'SYS_A78');
      if (targets.length === 1) raw = name = decodeHTML(source.name(targets[0]));
    }
    if (source.tags(identity).length || source.props(identity).description || source.children(identity).some(child => source.kind(child) !== 'tuple')
      || source.tuples(identity).some(([, key]) => !['SYS_A78', 'SYS_A70'].includes(key)) || /[,，\r\n]|\[\[|\(\(|(?:^|\s)#/.test(name) || /<[^>]+>/.test(raw)) return null;
    return name;
  }
  tryScalar(field, identity) {
    try { return this.scalarValue(field, identity); }
    catch (error) {
      if (error instanceof RangeError || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  generated(key, text, properties = {}) { return new Block(stableUuid('generated:' + key), escapeSourceHashtags(text), null, properties); }
  occurrence(identity, owner, slot) {
    const key = String(owner) + ':' + slot + ':' + identity;
    const count = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, count);
    const block = this.generated('occurrence:' + key + ':' + count, this.reference(identity));
    if (this.source.props(identity)._ownerId === owner && ['journal', 'journalPart'].includes(this.source.kind(identity))
      && ['home', 'journal', 'journalPart'].includes(this.source.kind(owner))) this.calendarNavigation.add(block.uuid);
    return block;
  }
  metadata(identity, block) {
    const source = this.source, data = source.props(identity);
    const tags = this.tags.has(identity) || this.fields.has(identity) ? [] : this.expandedTags(identity);
    this.nativeTags.set(block.uuid, tags);
    if (tags.length) {
      const tagText = tags.map(tag => '#[[' + this.pageFor.get(tag).name + ']]').join(' ');
      if (block.text.startsWith('```')) block.text = tagText + '\n' + block.text;
      else {
        const lines = block.text.split('\n');
        lines[0] += (lines[0] ? ' ' : '') + tagText;
        block.text = lines.join('\n');
      }
    }
    const checkbox = [identity, ...tags].some(tag => source.setting(tag, 'SYS_A55', {meta: true}).includes('SYS_V03') || source.tags(tag).includes('SYS_T100'));
    const done = data._done, first = block.text.split(' ')[0];
    if ((has(data, '_done') || checkbox || source.tags(identity).includes('SYS_T100')) && !TASK_MARKERS.has(first) && source.kind(identity) !== 'codeblock') block.text = (done ? 'DONE ' : 'TODO ') + block.text;
    else if (has(data, '_done') && source.kind(identity) !== 'codeblock') {
      if ((done && first !== 'DONE') || (!done && ['DONE', 'CANCELED', 'CANCELLED'].includes(first))) block.text = (done ? 'DONE ' : 'TODO ') + block.text;
    }
    if (data.description) block.children.push(this.generated('description:' + identity, this.rich(data.description)));
    if (source.kind(identity) === 'chat') {
      for (const value of source.setting(identity, 'SYS_A31', {meta: true})) if (source.nodes.has(value)) block.children.push(this.emitNode(value));
    }
  }
  emitField(tupleId, field, values, block) {
    const descriptor = this.fields.get(field), source = this.source, key = descriptor.key;
    if (this.emitNativeField(tupleId, field, values, block)) return;
    let converted = [], rich = [];
    for (const identity of values) {
      let value = this.tryScalar(field, identity);
      if (value === null) {
        rich.push(identity);
        value = this.reference(identity);
      } else if (!this.pageFor.has(identity) && source.props(identity)._ownerId === tupleId) this.scalarIds.set(identity, {owner: block.uuid, property: key, value, tuple_id: tupleId});
      converted.push(value);
    }
    const atoms = converted.map(value => value.trim().toLowerCase().normalize('NFC'));
    if (new Set(atoms).size !== atoms.length || (converted.length > 1 && converted.includes(''))) {
      rich = [...values];
      converted = values.map(identity => this.reference(identity));
      descriptor.query_safe = false;
      this.issue('duplicate-property-values-preserved-as-blocks', tupleId, {field});
    }
    const incoming = converted.join(', ');
    if (has(block.properties, key) && incoming) block.properties[key] += (block.properties[key] ? ', ' : '') + incoming;
    else if (!has(block.properties, key)) block.properties[key] = incoming;
    this.representations.set(tupleId, {status: 'property', owner: block.uuid, property: key, values: [...values]});
    if (rich.length) {
      const holder = new Block(sourceUuid(tupleId), this.reference(field) + ' — source values', tupleId, {collapsed: 'true'});
      values.forEach((identity, index) => holder.children.push(this.pageFor.has(identity) || this.emitted.has(identity) || source.props(identity)._ownerId !== tupleId ? this.occurrence(identity, tupleId, index) : this.emitNode(identity)));
      block.children.push(holder);
      this.emitted.add(tupleId);
    }
  }
  emitNativeField(tupleId, field, values, block) {
    const source = this.source, descriptor = this.fields.get(field);
    const name = descriptor.source_name.trim().toLowerCase();
    if (!['heading', 'title'].includes(name) || values.length !== 1) return false;
    const identity = values[0], value = this.plain(identity).trim();
    // Rich values and shared records are real content, not presentation hints.
    if (source.props(identity)._ownerId !== tupleId || source.kind(identity) !== 'node'
      || source.children(identity).length || source.tags(identity).length || source.props(identity).description
      || /[\r\n]/.test(source.name(identity)) || /<[^>]+>/.test(source.name(identity))) return false;
    let representation;
    if (name === 'heading') {
      if (!/^[1-6]$/.test(value) || source.kind(source.props(tupleId)._ownerId) === 'codeblock') return false;
      const heading = block.text.match(/^(#{1,6})\s/);
      if (heading && heading[1].length !== Number(value)) return false;
      if (!heading) block.text = '#'.repeat(Number(value)) + ' ' + block.text;
      representation = 'native-heading';
    } else {
      const owner = source.props(tupleId)._ownerId;
      const day = source.kind(owner) === 'journalPart' ? isoDay(source.calendarDate(owner)) : null;
      if (value && (value === this.plain(owner).trim() || titleMatchesDay(value, day))) {
        representation = 'redundant-title';
      } else if (value && !source.name(owner).trim() && !block.text.trim()) {
        block.text = this.rich(source.name(identity));
        representation = 'native-title';
      } else return false;
    }
    const record = {status: representation, owner: block.uuid, value, field, tuple_id: tupleId};
    this.nativeValues.add(identity);
    this.representations.set(identity, record);
    this.representations.set(tupleId, {...record, values: [...values]});
    // A property predicate cannot retain its meaning after native presentation
    // replaces some values. Preserve such searches in the JSON audit instead.
    descriptor.query_safe = false;
    this.issue('field-mapped-to-native-content', tupleId, {field, representation});
    return true;
  }
  emitChildren(identity, block) {
    const source = this.source;
    source.children(identity).forEach((child, index) => {
      const kind = source.kind(child);
      if (kind === 'tuple') {
        const children = source.children(child);
        if (children.length && this.fields.has(children[0])) this.emitField(child, children[0], children.slice(1), block);
        else if (children.length && children[0].startsWith('SYS_')) this.representations.set(child, {status: 'source-metadata', owner: identity, definition: children[0]});
        else {
          this.issue('unrecognized-field-tuple-retained', child);
          const holder = new Block(sourceUuid(child), 'Source field', child);
          children.forEach((value, position) => holder.children.push(source.props(value)._ownerId !== child ? this.occurrence(value, child, position) : this.emitNode(value)));
          block.children.push(holder);
          this.emitted.add(child);
        }
        return;
      }
      if (this.refs.has(child) && kind === 'journalPart' && isoDay(source.calendarDate(child))) block.children.push(this.occurrence(child, identity, index));
      else if (this.pageFor.has(child) || this.emitted.has(child) || source.props(child)._ownerId !== identity) block.children.push(this.occurrence(child, identity, index));
      else if (child.startsWith('SYS_') || METADATA_KINDS.has(kind)) this.representations.set(child, {status: 'source-metadata', owner: identity});
      else block.children.push(this.emitNode(child));
    });
  }
  emitNode(identity) {
    if (this.emitted.has(identity)) return this.occurrence(identity, 'repeated', this.emitted.size);
    this.emitted.add(identity);
    if (!this.source.nodes.has(identity)) {
      this.issue('reference-target-missing-from-exports', identity);
      return new Block(sourceUuid(identity), 'Unavailable Tana node: ' + identity, identity);
    }
    const block = new Block(sourceUuid(identity), this.title(identity), identity);
    this.metadata(identity, block);
    if (this.source.kind(identity) === 'search') this.queryTargets.push([identity, block]);
    else {
      this.emitChildren(identity, block);
      if (this.source.views(identity).length) this.viewTargets.push([identity, block]);
    }
    if (!CONTENT_KINDS.has(this.source.kind(identity)) && !['tagDef', 'attrDef', 'home', 'tuple'].includes(this.source.kind(identity))) this.issue('node-kind-preserved-as-outline', identity, {kind: this.source.kind(identity)});
    return block;
  }
  emitSchema() {
    for (const identity of sorted(this.fields.keys())) {
      const descriptor = this.fields.get(identity), page = this.pageFor.get(identity);
      this.emitted.add(identity);
      const block = new Block(sourceUuid(identity), this.rich(this.source.name(identity)), identity);
      this.metadata(identity, block);
      block.children.push(this.generated('field-type:' + identity, 'Source field type: ' + descriptor.declared_type));
      descriptor.options.forEach((option, index) => block.children.push(this.pageFor.has(option) || this.emitted.has(option) || this.source.kind(this.source.props(option)._ownerId) !== 'tuple' ? this.occurrence(option, identity, index) : this.emitNode(option)));
      page.blocks.push(block);
    }
    for (const identity of sorted([...this.tags].filter(tag => !this.fields.has(tag)))) {
      const page = this.pageFor.get(identity);
      page.blocks.push(this.emitNode(identity));
      const defaults = this.source.setting(identity, 'SYS_A62', {meta: true});
      for (const value of defaults) page.blocks.push(this.emitNode(value));
      if (defaults.length || this.source.setting(identity, 'SYS_A156', {meta: true}).length) this.issue('tag-defaults-and-optional-fields-retained-without-enforcement', identity);
    }
  }
  emitLayout() {
    const source = this.source;
    this.emitSchema();
    for (const [identity, page] of [...this.pageFor]) if (!this.emitted.has(identity) && page.kind === 'root') page.blocks.push(this.emitNode(identity));
    for (const [workspace, home] of source.homes) {
      const root = source.roots.get(workspace);
      const flattened = workspace === this.rootWorkspace || this.sharedWorkspaces.has(workspace);
      this.emitted.add(home);
      if (flattened) {
        const anchor = new Block(sourceUuid(home), 'Source workspace: ' + this.plain(home), home);
        this.metadata(home, anchor);
        source.children(home).forEach((child, index) => {
          if (source.kind(child) === 'tuple') {
            const values = source.children(child);
            if (values.length && this.fields.has(values[0])) this.emitField(child, values[0], values.slice(1), anchor);
          } else anchor.children.push(this.occurrence(child, home, index));
        });
        this.index.blocks.push(anchor);
        for (const child of source.children(home)) {
          if (source.kind(child) === 'journal' && !this.emitted.has(child)) this.index.blocks.push(this.emitNode(child));
        }
        if (source.views(home).length) this.viewTargets.push([home, anchor]);
      } else {
        const page = this.pageFor.get(home);
        const anchor = new Block(sourceUuid(home), this.title(home), home);
        this.metadata(home, anchor);
        page.blocks.push(anchor);
        const holder = this.generated('home-content:' + home, '');
        this.emitChildren(home, holder);
        Object.assign(anchor.properties, holder.properties);
        extend(page.blocks, holder.children);
        if (source.views(home).length) this.viewTargets.push([home, anchor]);
      }
      for (const suffix of ['_SCHEMA', '_SEARCHES', '_CAPTURE_INBOX']) {
        const container = root + suffix;
        if (!source.nodes.has(container)) continue;
        const holder = this.emitNode(container);
        const page = holder.children.length || source.props(container).description ? (flattened ? this.index : this.pageFor.get(home)) : this.index;
        page.blocks.push(holder);
      }
      const library = root + '_STASH';
      if (source.nodes.has(library)) {
        const holder = this.emitNode(library);
        (flattened ? this.index : this.pageFor.get(home)).blocks.push(holder);
        this.representations.set(library, {status: 'library', workspace, uuid: holder.uuid});
      }
    }
    for (const identity of this.periodAnchors.keys()) {
      if (!isoDay(source.calendarDate(identity)) && !this.emitted.has(identity)) this.index.blocks.push(this.emitNode(identity));
    }
    for (const [day, sourceIds] of [...this.daySources].sort(([a], [b]) => compare(a, b))) {
      const page = this.dayPage(day);
      const order = sourceIds.slice().sort((a, b) => Number(source.workspace.get(a) !== this.rootWorkspace) - Number(source.workspace.get(b) !== this.rootWorkspace) || compare(source.workspace.get(a), source.workspace.get(b)) || compare(a, b));
      for (const identity of order) {
        const workspace = source.workspace.get(identity);
        this.emitted.add(identity);
        if (workspace === this.rootWorkspace) {
          const holder = this.generated('root-day:' + identity, '');
          this.emitChildren(identity, holder);
          for (const [key, value] of Object.entries(holder.properties)) {
            if (has(page.properties, key) && page.properties[key] !== value) {
              this.issue('merged-journal-property-conflict', identity, {property: key});
              page.blocks.push(this.generated('day-properties:' + identity, 'Source daily properties', holder.properties));
              break;
            }
            page.properties[key] = value;
          }
          extend(page.blocks, holder.children);
          if (source.props(identity).description) page.blocks.push(this.generated('day-description:' + identity, this.rich(source.props(identity).description)));
          if (source.views(identity).length) {
            const views = this.generated('day-views:' + identity, 'Daily views');
            this.viewTargets.push([identity, views]);
            page.blocks.push(views);
          }
        } else {
          const key = JSON.stringify([workspace, day]);
          if (!this.dayGroups.has(key)) {
            const home = source.homes.get(workspace);
            const text = this.sharedWorkspaces.has(workspace) ? 'Shared notes: ' + workspace : this.reference(home);
            const group = new Block(this.refs.get(identity).target, text, identity);
            this.metadata(identity, group);
            this.dayGroups.set(key, group);
            page.blocks.push(group);
          }
          const group = this.dayGroups.get(key);
          this.emitChildren(identity, group);
          if (source.views(identity).length) this.viewTargets.push([identity, group]);
        }
        this.representations.set(identity, {status: 'journal', page: page.name, path: page.path, day, workspace, target: this.refs.get(identity)});
      }
    }
  }
  definition(identity, view = null) {
    const key = identity + (view ? ':' + view : '');
    const path = 'assets/tana-source/definitions/' + stableUuid(key) + '.json';
    if (!this.definitions.has(path)) {
      const source = this.source, views = view ? [view] : source.views(identity);
      this.definitions.set(path, {source_id: identity, source_record: source.nodes.get(identity), metadata: source.archive(source.meta(identity)),
        views: Object.fromEntries(views.map(item => [item, source.archive(item)])), result_ids: source.children(identity), workspace_export: '../exports/' + source.workspace.get(identity) + '.json'});
    }
    return path;
  }
  queryBlock(identity, view, expressions, {ordinary = false} = {}) {
    const suffix = view || 'default';
    const label = view ? this.plain(view) : 'Search';
    const block = this.generated('query:' + identity + ':' + suffix, label);
    const record = {source_id: identity, view_id: view, uuid: block.uuid, context_id: this.source.props(identity).searchContextNode ?? identity,
      result_ids: [...this.source.children(identity)], source_definition_path: this.definition(identity, view)};
    try {
      if (ordinary) {
        if (!this.tags.has(identity)) throw new UnsupportedQuery('Original direct-child placements have no exact native query predicate; exported children remain in the outline');
        expressions = [identity, ...expressions];
      }
      const compiler = new Compiler(this, record.context_id);
      const expression = compiler.compile(expressions);
      if (expression.includes('\n') || Buffer.byteLength(expression) > 16000) throw new UnsupportedQuery('Query exceeds safe single-line import limits');
      block.text = '{{tine-query ' + expression + '}}';
      Object.assign(record, {status: 'translated', expression});
      if (compiler.adaptations.size) record.native_adaptations = [...compiler.adaptations.values()];
      this.nativeQueries.push([record, block, compiler.scope]);
    } catch (error) {
      if (!(error instanceof UnsupportedQuery)) throw error;
      this.querySnapshot(record, block, error.message);
    }
    if (view) {
      const [settings, limitations] = viewSettings(this, view);
      if (record.status === 'translated') Object.assign(block.properties, settings);
      record.view_properties = settings;
      record.view_limitations = limitations;
      for (const limitation of limitations) this.issue('view-setting-degraded', view, {reason: limitation});
    }
    this.queries.push(record);
    return block;
  }
  querySnapshot(record, block, reason) {
    const identity = record.source_id, view = record.view_id;
    Object.assign(record, {status: 'snapshot', expression: null, reason, visible: false});
    block.text = '';
    block.properties = {};
    this.issue('query-preserved-as-snapshot', identity, {view_id: view, reason});
  }
  pruneQuerySnapshots() {
    const omitted = new Set(this.queries.filter(record => record.status === 'snapshot').map(record => record.uuid));
    const references = new Set();
    const scan = value => { for (const match of value.matchAll(/\(\(([\da-f-]{36})\)\)/gi)) references.add(match[1].toLowerCase()); };
    const walk = block => {
      if (omitted.has(block.uuid)) return;
      scan(block.text);
      Object.values(block.properties).forEach(scan);
      block.children.forEach(walk);
    };
    for (const page of [...this.pages.values(), this.index]) {
      Object.values(page.properties).forEach(scan);
      page.blocks.forEach(walk);
    }
    const dailyViews = new Set([...this.daySources.values()].flat().map(identity => stableUuid('generated:day-views:' + identity)));
    const prune = blocks => blocks.filter(block => {
      if (omitted.has(block.uuid)) return false;
      block.children = prune(block.children);
      if (block.children.length || Object.keys(block.properties).length) return true;
      if (dailyViews.has(block.uuid)) return false;
      const identity = block.sourceId;
      if (!identity || this.source.kind(identity) !== 'search' || references.has(block.uuid)
        || this.source.tags(identity).length || has(this.source.props(identity), '_done')) return true;
      this.required.delete(identity);
      this.representations.set(identity, {status: 'json-query', definitions: this.queries.filter(q => q.source_id === identity).map(q => q.source_definition_path)});
      return false;
    });
    for (const page of [...this.pages.values(), this.index]) page.blocks = prune(page.blocks);
  }
  validateNativeQueries() {
    const scope = new NativeScope(this);
    for (const [record, block, candidates] of this.nativeQueries) {
      try {
        record.scope_validation = scope.validate(candidates);
      } catch (error) {
        if (!(error instanceof UnsupportedQuery)) throw error;
        this.querySnapshot(record, block, error.message);
      }
    }
  }
  emitQueries() {
    while (this.queriesProcessed < this.queryTargets.length || this.viewsProcessed < this.viewTargets.length) {
      while (this.queriesProcessed < this.queryTargets.length) {
        const [identity, block] = this.queryTargets[this.queriesProcessed++];
        const source = this.source;
        const views = source.views(identity).length ? source.views(identity) : [null];
        const base = source.setting(identity, 'SYS_A15', {meta: true});
        for (const view of views) block.children.push(this.queryBlock(identity, view, unique([...base, ...(view ? source.setting(view, 'SYS_A15') : [])])));
        source.children(identity).forEach(child => {
          if (source.kind(child) === 'tuple') {
            const values = source.children(child);
            if (values.length && this.fields.has(values[0])) this.emitField(child, values[0], values.slice(1), block);
            else this.issue('search-child-tuple-retained-in-definition', child, {search: identity});
          } else if (!this.emitted.has(child) && !this.pageFor.has(child) && source.props(child)._ownerId === identity) {
            // A note created inside a search is real content. Other children are
            // cached search hits; their IDs and definitions stay in JSON only.
            block.children.push(this.emitNode(child));
          }
        });
      }
      while (this.viewsProcessed < this.viewTargets.length) {
        const [identity, block] = this.viewTargets[this.viewsProcessed++];
        for (const view of this.source.views(identity)) block.children.push(this.queryBlock(identity, view, this.source.setting(view, 'SYS_A15'), {ordinary: true}));
      }
    }
  }
  recoveryPage() {
    if (!this.recoveredPage) this.recoveredPage = this.newPage('generated:recovered', 'Recovered notes', 'recovered');
    return this.recoveredPage;
  }
  recover() {
    const source = this.source;
    const candidates = [...source.nodes.keys()].filter(identity => !(this.emitted.has(identity) || this.scalarIds.has(identity) || this.nativeValues.has(identity) || identity.startsWith('SYS_') || !source.active(identity) || !CONTENT_KINDS.has(source.kind(identity)))
      && !source.lineage(identity).slice(1).some(ancestor => METADATA_KINDS.has(source.kind(ancestor)) || source.kind(ancestor) === 'attrDef'));
    candidates.sort((a, b) => source.lineage(a).length - source.lineage(b).length || compare(a, b));
    for (const identity of candidates) {
      if (this.emitted.has(identity) || this.scalarIds.has(identity) || this.nativeValues.has(identity)) continue;
      const block = this.emitNode(identity);
      const context = source.lineage(identity).slice(1).find(ancestor => (CONTENT_KINDS.has(source.kind(ancestor)) || ['home', 'tagDef', 'attrDef'].includes(source.kind(ancestor))) && !ancestor.startsWith('SYS_'));
      if (context) block.children.unshift(this.generated('recovered-context:' + identity, 'Original context: ' + this.reference(context)));
      this.recoveryPage().blocks.push(block);
      this.issue('active-content-recovered-outside-exported-outline', identity);
    }
    for (;;) {
      const unresolved = sorted([...this.required].filter(identity => !this.emitted.has(identity) && !this.refs.has(identity)));
      if (!unresolved.length) break;
      for (const identity of unresolved) {
        this.recoveryPage().blocks.push(this.emitNode(identity));
        if (source.trashed(identity)) this.issue('referenced-archived-content-recovered', identity);
      }
    }
  }
  flattenCalendarsToJournals() {
    const source = this.source, periods = [], calendars = [];
    const visit = blocks => blocks.flatMap(block => {
      if (this.calendarNavigation.has(block.uuid)) return [];
      block.children = visit(block.children);
      const identity = block.sourceId, kind = source.kind(identity);
      if (identity && kind === 'journalPart') { periods.push(block); return []; }
      if (identity && kind === 'journal') { calendars.push(block); return []; }
      return [block];
    });
    for (const page of [...this.pages.values(), this.index]) if (page.kind !== 'journal') page.blocks = visit(page.blocks);
    const references = new Set(), pageRefs = new Set();
    const scan = block => {
      for (const text of [block.text, ...Object.values(block.properties)]) {
        for (const match of text.matchAll(/\(\(([\da-f-]{36})\)\)/gi)) references.add(match[1].toLowerCase());
        for (const match of text.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) pageRefs.add(match[1]);
      }
      block.children.forEach(scan);
    };
    for (const page of [...this.pages.values(), this.index]) {
      scan({text: '', properties: page.properties, children: page.blocks});
    }
    periods.forEach(scan);
    for (const block of periods) {
      const identity = block.sourceId, day = this.periodAnchors.get(identity), target = this.refs.get(identity);
      if (!day || !target) throw new Error('Unmapped calendar period: ' + identity);
      const hasMetadata = Object.keys(block.properties).length || block.text !== this.title(identity);
      const referenced = target.type === 'page' ? pageRefs.has(target.target) : references.has(target.target);
      if (!block.children.length && !hasMetadata && !referenced) {
        this.required.delete(identity);
        this.representations.set(identity, {status: 'calendar-navigation', day, period: source.calendarDate(identity)});
        continue;
      }
      const workspace = source.workspace.get(identity), page = this.dayPage(day);
      page.sourceIds.push(identity);
      let children = page.blocks;
      if (workspace !== this.rootWorkspace) {
        const key = JSON.stringify([workspace, day]);
        if (!this.dayGroups.has(key)) {
          const text = this.sharedWorkspaces.has(workspace) ? 'Shared notes: ' + workspace : this.reference(source.homes.get(workspace));
          const group = new Block(target.target, text, hasMetadata ? null : identity);
          this.dayGroups.set(key, group);
          page.blocks.push(group);
        }
        children = this.dayGroups.get(key).children;
      }
      extend(children, hasMetadata ? [block] : block.children);
      this.representations.set(identity, {status: 'journal', page: page.name, path: page.path, day, workspace, target, period: source.calendarDate(identity)});
      this.issue('calendar-period-anchored-to-journal', identity, {period: source.calendarDate(identity), day, workspace});
    }
    for (const block of calendars) {
      const identity = block.sourceId, page = this.pageFor.get(identity);
      if (block.children.length || Object.keys(block.properties).length || block.text !== this.title(identity)) throw new Error('Calendar has undated authored content: ' + identity);
      if (references.has(block.uuid)) this.recoveryPage().blocks.push(block);
      else this.required.delete(identity);
      this.representations.set(identity, {status: 'calendar-navigation'});
      if (page && !page.blocks.length && !pageRefs.has(page.name)) {
        for (const [key, candidate] of this.pages) if (candidate === page) this.pages.delete(key);
        this.pageFor.delete(identity);
        this.refs.delete(identity);
      }
    }
  }
  pruneCalendarMetadata() {
    // Excluding a calendar supertag can leave a period label with no metadata.
    // Reconcile that decision without leaving empty week/year placeholders.
    const references = new Set(), pageRefs = new Set(), removed = [], removedPages = [];
    const scan = block => {
      for (const text of [block.text, ...Object.values(block.properties)]) {
        for (const match of text.matchAll(/\(\(([\da-f-]{36})\)\)/gi)) references.add(match[1].toLowerCase());
        for (const match of text.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) pageRefs.add(match[1]);
      }
      block.children.forEach(scan);
    };
    for (const page of this.pages.values()) scan({text:'',properties:page.properties,children:page.blocks});
    const disposableGroups = new Set([...this.dayGroups].filter(([key]) => {
      const [workspace, day] = JSON.parse(key);
      return !(this.daySources.get(day) ?? []).some(id => this.source.workspace.get(id) === workspace);
    }).map(([,group]) => group.uuid));
    const prune = blocks => blocks.flatMap(block => {
      block.children = prune(block.children);
      const identity = block.sourceId;
      const periodLabel = identity && this.periodAnchors.has(identity) && !isoDay(this.source.calendarDate(identity))
        && block.uuid === sourceUuid(identity) && block.text.trim() === this.title(identity).trim();
      if (!Object.keys(block.properties).length && !references.has(block.uuid)
        && (periodLabel || disposableGroups.has(block.uuid) && !block.children.length)) {
        removed.push(block.uuid);
        return block.children;
      }
      return [block];
    });
    for (const [key,page] of this.pages) if (page.kind === 'journal') {
      page.blocks = prune(page.blocks);
      if (!page.blocks.length && !Object.keys(page.properties).length && !pageRefs.has(page.name) && page.sourceIds.length
        && page.sourceIds.every(id => !isoDay(this.source.calendarDate(id)))) {
        this.pages.delete(key);
        removedPages.push(page.path);
      }
    }
    for (const [identity,day] of this.periodAnchors) {
      const reference = this.refs.get(identity);
      if ((reference.type === 'block' && removed.includes(reference.target)) || (reference.type === 'page' && !this.pages.has('journal:' + day))) {
        this.required.delete(identity);
        this.representations.set(identity,{status:'calendar-navigation',day,period:this.source.calendarDate(identity)});
      }
    }
    return {removed_block_ids:removed,removed_pages:removedPages};
  }
  retainWorkspaceNotes() {
    const references = new Set();
    const scan = value => { for (const match of value.matchAll(/\(\(([\da-f-]{36})\)\)/gi)) references.add(match[1].toLowerCase()); };
    const walk = block => {
      scan(block.text);
      Object.values(block.properties).forEach(scan);
      block.children.forEach(walk);
    };
    for (const page of this.pages.values()) {
      Object.values(page.properties).forEach(scan);
      page.blocks.forEach(walk);
    }
    const referenced = block => references.has(block.uuid) || block.children.some(referenced);
    const content = (block, root = false) => Object.keys(block.properties).length
      || (!root && (block.sourceId || !/^(?:\[\[[^\n]*\]\]|\(\([\da-f-]{36}\)\))$/i.test(block.text)))
      || block.children.some(child => content(child));
    // Keep authored workspace metadata, source-owned notes, and any structural
    // block that a real note references. Discard redundant navigation lists.
    const retained = new Set();
    let changed;
    do {
      changed = false;
      for (const block of this.index.blocks) {
        if (retained.has(block)) continue;
        const props = this.source.props(block.sourceId);
        if (referenced(block) || content(block, true) || props.description || has(props, '_done') || this.source.tags(block.sourceId).length) {
          retained.add(block);
          walk(block);
          changed = true;
        }
      }
    } while (changed);
    for (const block of this.index.blocks) if (retained.has(block)) this.recoveryPage().blocks.push(block);
    this.index.blocks = [];
  }
  finish() {
    this.prepare();
    this.emitLayout();
    this.emitQueries();
    this.recover();
    while (this.queriesProcessed < this.queryTargets.length || this.viewsProcessed < this.viewTargets.length) {
      this.emitQueries();
      this.recover();
    }
    for (const [identity, descriptor] of this.fields) this.pageFor.get(identity).properties['tine.type'] = descriptor.query_type;
    this.pruneQuerySnapshots();
    this.flattenCalendarsToJournals();
    this.retainWorkspaceNotes();
    this.issue('source-metadata-retained-in-json', null, {count: [...this.source.nodes.keys()].filter(identity => !this.emitted.has(identity) && !this.scalarIds.has(identity)).length,
      details: 'Includes system definitions, deleted content, unsupported automation/formulas, UI state, and source editor history'});
    this.validateNativeQueries();
    this.pruneQuerySnapshots();
    this.validateIds();
    return this;
  }
  validateIds() {
    const seen = new Set();
    const walk = block => {
      if (seen.has(block.uuid)) throw new Error('Duplicate persisted block UUID: ' + block.uuid);
      seen.add(block.uuid);
      for (const child of block.children) walk(child);
    };
    for (const page of this.pages.values()) for (const block of page.blocks) walk(block);
    const missing = [...this.required].filter(identity => {
      const reference = this.refs.get(identity);
      return (!reference || reference.type === 'block') && !seen.has(reference?.target ?? sourceUuid(identity));
    });
    if (missing.length) throw new Error('Unresolved generated references: ' + missing.slice(0, 20).join(', '));
  }
  sourceProvenance(identity) {
    const source = this.source, data = source.props(identity), workspace = source.workspace.get(identity);
    const parents = unique(source.parents.get(identity) ?? []);
    const entry = {workspace, workspace_id: source.roots.get(workspace), kind: source.kind(identity), active: source.active(identity),
      source_parent: data._ownerId ?? null, source_children: source.children(identity), source_placements: parents};
    const days = parents.filter(parent => source.kind(parent) === 'journalPart').map(parent => isoDay(source.calendarDate(parent))).filter(Boolean);
    if (days.length) entry.day_placements = unique(days);
    const links = [...source.name(identity).matchAll(/data-inlineref-node=["']([^"']+)/g)].map(match => match[1]);
    extend(links, source.children(identity).filter(child => source.props(child)._ownerId !== identity && source.kind(child) !== 'tuple'));
    for (const [tupleId, field, values] of source.tuples(identity)) if (this.fields.has(field)) extend(links, values.filter(value => source.props(value)._ownerId !== tupleId));
    if (links.length) entry.link_targets = unique(links);
    const day = source.dayContext(identity);
    if (day) entry.calendar_day = day;
    if (has(data, 'created')) entry.created = data.created;
    if (has(source.nodes.get(identity), 'modifiedTs')) entry.modified_timestamps = source.nodes.get(identity).modifiedTs;
    if (has(data, '_done')) entry.done = data._done;
    return entry;
  }
  manifest(expected, files) {
    const source = this.source;
    const placed = new Map(expected.filter(entry => entry.source_id).map(entry => [entry.source_id, entry]));
    const nodes = Object.fromEntries([...source.nodes.keys()].map(identity => {
      const entry = this.sourceProvenance(identity);
      if (placed.has(identity)) {
        const block = placed.get(identity);
        Object.assign(entry, {status: 'block', uuid: block.uuid, page: block.page, path: block.path, parent: block.parent});
      } else if (this.representations.has(identity)) Object.assign(entry, this.representations.get(identity));
      else if (this.scalarIds.has(identity)) Object.assign(entry, {status: 'property-value'}, this.scalarIds.get(identity));
      else if (this.refs.has(identity)) Object.assign(entry, {status: 'structural-reference', target: this.refs.get(identity)});
      else entry.status = source.trashed(identity) ? 'archived-trash' : source.active(identity) || identity.startsWith('SYS_') ? 'archived-metadata' : 'archived-unattached';
      if (this.refs.has(identity)) entry.reference = this.refs.get(identity);
      return [identity, entry];
    }));
    return {format_version: 1, converter: 'tana-to-tine', converter_version: '1.0.0', sources: source.files,
      roles: {root_workspace: this.rootWorkspace, shared_workspaces: sorted(this.sharedWorkspaces), workspace_titles: this.workspaceTitles}, field_names: this.fieldNames,
      counts: {source_records: [...source.exports.values()].reduce((total, data) => total + data.docs.length, 0), source_unique_nodes: source.nodes.size,
        pages: this.pages.size, blocks: expected.length, queries: this.queries.length, fields: this.fields.size, tags: this.tags.size,
        journals: [...this.pages.values()].filter(page => page.kind === 'journal').length,
        node_statuses: countBy(Object.values(nodes).map(node => node.status)), query_statuses: countBy(this.queries.map(query => query.status))},
      nodes, pages: [...this.pages.values()].map(page => ({name: page.name, path: page.path, kind: page.kind, source_ids: page.sourceIds,
        properties: pageProperties(page), root_ids: page.blocks.map(block => block.uuid), ...files[page.path]})),
      fields: Object.fromEntries(this.fields), tags: Object.fromEntries(sorted(this.tags).map(identity => [identity, {page: this.pageFor.get(identity).name,
        parents: source.tags(identity).filter(tag => this.tags.has(tag)), expanded_parents: this.expandedTags(identity)}])),
      queries: this.queries, issues: this.issues, renames: this.names.renames, assets: this.assets, expected_blocks: expected,
      fidelity: {source_archives: 'Byte-for-byte export copies under assets/tana-source/exports',
        calendar_periods: 'Calendar navigation is omitted; weekly notes use the Sunday starting the week, monthly notes the first day, and yearly notes January 1, grouped by workspace in shared journals',
        queries: 'All-or-nothing conservative translation; exported result IDs and original definitions are retained in JSON assets, not appended to graph queries',
        tag_inheritance: 'Ancestor tags are materialized on imported instances; future Tine edits do not enforce inheritance',
        templates: 'Exported values, defaults and schemas are retained; Tana automation/default application is not executed',
        graph_properties: 'Only authored fields and required native Tine properties; no generated source metadata properties',
        source_scopes: 'Named workspaces use native owning-page/ancestor references; root scope excludes named workspace references. Queries search retained notes without migration-specific page exclusions. Cached search hits do not restore archived notes; explicit note references remain resolvable',
        timestamps: 'Source timestamps are retained in this manifest and the unchanged source archives, not as native Tine edit history'}};
  }
}
