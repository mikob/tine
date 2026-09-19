/** Source indexing and the file-format model. Disk schemas retain their original keys. */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {decodeHTML} from 'entities';
import {caseFold} from 'unicode-case-folding';
import {mapWorkers} from '../workers.mjs';

const NAMESPACE = Buffer.from('e3425b401b595b7f9bcac408ba5401ef', 'hex');
export const CONTENT_KINDS = new Set(['node', 'url', 'codeblock', 'visual', 'chat', 'group', 'search', 'journal', 'journalPart']);
export const METADATA_KINDS = new Set(['metanode', 'viewDef', 'associatedData', 'settings', 'settingsSection', 'command', 'systemTool', 'hotkey']);
export const unique = values => [...new Set(values)];
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const sha256 = payload => createHash('sha256').update(payload).digest('hex');
export function extend(target, values) {
  for (const value of values) target.push(value);
}
export function appendTo(map, key, values) {
  if (!map.has(key)) map.set(key, []);
  extend(map.get(key), values);
}
export function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(counts);
}
function formatUuid(hex) {
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
export function stableUuid(value) {
  const digest = createHash('sha1').update(NAMESPACE).update(value, 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest.subarray(0, 16).toString('hex'));
}
export function sourceUuid(identity) {
  const hex = identity.replace(/^urn:uuid:/, '').replace(/^\{+|\}+$/g, '').replaceAll('-', '');
  return /^[\da-f]{32}$/i.test(hex) ? formatUuid(hex.toLowerCase()) : stableUuid('tana-node:' + identity);
}
export function datesIn(value) {
  return [...value.matchAll(/data-inlineref-date=["'](.*?)["']/gs)].map(match => JSON.parse(decodeHTML(match[1])));
}
export function isoDay(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new RangeError('Invalid calendar date: ' + value);
  return value;
}
export function journalTitle(day) {
  if (!isoDay(day)) throw new RangeError('Invalid journal date: ' + day);
  const [year, month, date] = day.split('-').map(Number);
  const ordinal = date % 100 >= 11 && date % 100 <= 13 ? 'th' : ({1: 'st', 2: 'nd', 3: 'rd'}[date % 10] ?? 'th');
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1] + ' ' + date + ordinal + ', ' + year;
}
export function pageIdentity(name) {
  return name.trim().toLowerCase().replace(/^\//, '').replace(/\/$/, '').normalize('NFC');
}
function percentEncode(value) {
  return [...Buffer.from(value)].map(byte => '%' + byte.toString(16).toUpperCase().padStart(2, '0')).join('');
}
export function encodePageName(name) {
  const characters = [...name];
  const trailing = [...name.replace(/[ .]+$/, '')].length;
  let result = characters.map((character, index) => {
    const code = character.codePointAt(0);
    return character === '%' || code < 32 || code === 127 || '<>:"\\|?*#'.includes(character)
      || (character === '.' && (index === 0 || index >= trailing)) || (character === ' ' && index >= trailing)
      ? percentEncode(character) : character;
  }).join('').replaceAll('___', '%5F%5F%5F').replaceAll('_/', '%5F/').replaceAll('/_', '/%5F').replaceAll('/', '___');
  const body = result.split('.')[0].replace(/ +$/, '').toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³])$/.test(body)) result = percentEncode(result[0]) + result.slice(1);
  return result;
}
export class Names {
  logical = new Map();
  physical = new Map();
  renames = [];
  allocate(requested, identity) {
    let name = requested.replace(/[\r\n\t]+/g, ' ').trim().normalize('NFC')
      .replaceAll('[[', '［［').replaceAll(']]', '］］').replace(/^\/+|\/+$/g, '').trim();
    if (!name) name = 'Untitled ' + sourceUuid(identity).slice(0, 8);
    const base = name;
    const filename = title => {
      const encoded = encodePageName(title);
      return Buffer.byteLength(encoded + '.md') > 230 ? 'page-' + sha256(identity).slice(0, 24) : encoded;
    };
    let candidate = filename(name);
    let key = pageIdentity(name);
    let fileKey = caseFold(candidate.normalize('NFC'));
    if ((this.logical.has(key) && this.logical.get(key) !== identity) || (this.physical.has(fileKey) && this.physical.get(fileKey) !== identity)) {
      name = base + ' · ' + sourceUuid(identity).slice(0, 8);
      candidate = filename(name);
      key = pageIdentity(name);
      fileKey = caseFold(candidate.normalize('NFC'));
      if (this.logical.has(key) || this.physical.has(fileKey)) throw new Error('Cannot allocate unique page name for ' + identity);
    }
    this.logical.set(key, identity);
    this.physical.set(fileKey, identity);
    if (name !== requested || candidate !== encodePageName(name)) this.renames.push({source_id: identity, source_name: requested, name, filename: candidate + '.md'});
    return [name, 'pages/' + candidate + '.md'];
  }
}
export async function readExport(filename) {
  const target = path.resolve(filename);
  const payload = await readFile(target);
  const data = JSON.parse(payload.toString('utf8'));
  if (data.formatVersion !== 1 || !Array.isArray(data.docs)) throw new Error('Unsupported export format: ' + target);
  const workspace = path.basename(target, path.extname(target));
  return [workspace, data, {path: target, workspace, sha256: sha256(payload), size: payload.length, record_count: data.docs.length}];
}
export class Source {
  nodes = new Map();
  workspace = new Map();
  homes = new Map();
  roots = new Map();
  owned = new Map();
  parents = new Map();
  lineages = new Map();
  tagCache = new Map();
  activeCache = new Map();
  days = new Map();
  duplicateSystemRecords = 0;
  constructor(exports, files = []) {
    this.exports = exports instanceof Map ? exports : new Map(Object.entries(exports));
    this.files = files;
    for (const [workspace, data] of [...this.exports].sort(([a], [b]) => compare(a, b))) {
      if (data.formatVersion !== 1 || !Array.isArray(data.docs)) throw new Error('Expected a Tana formatVersion 1 export in ' + workspace);
      const local = new Set();
      for (const node of data.docs) {
        const identity = node.id;
        if (typeof identity !== 'string' || !node.props || typeof node.props !== 'object' || Array.isArray(node.props) || local.has(identity)) throw new Error('Invalid or duplicate node ' + JSON.stringify(identity) + ' in ' + workspace);
        if (node.children !== undefined && (!Array.isArray(node.children) || node.children.some(child => typeof child !== 'string'))) throw new Error('Invalid children of ' + identity);
        local.add(identity);
        if (node.props._docType === 'home') {
          if (this.homes.has(workspace)) throw new Error('Multiple home nodes in ' + workspace);
          this.homes.set(workspace, identity);
          const owner = node.props._ownerId;
          if (typeof owner !== 'string') throw new Error('Workspace home has no owner: ' + identity);
          this.roots.set(workspace, owner);
        }
        if (this.nodes.has(identity)) {
          if (identity.startsWith('SYS_')) this.duplicateSystemRecords++;
          else if (!isDeepStrictEqual(this.nodes.get(identity), node)) throw new Error('Conflicting source records for ' + identity);
          continue;
        }
        this.nodes.set(identity, node);
        this.workspace.set(identity, workspace);
      }
    }
    if (this.homes.size !== this.exports.size) throw new Error('Every export must contain exactly one workspace home');
    for (const identity of this.nodes.keys()) {
      const owner = this.props(identity)._ownerId;
      if (owner) appendTo(this.owned, owner, [identity]);
      for (const child of this.children(identity)) appendTo(this.parents, child, [identity]);
    }
  }
  static async read(paths, jobs) {
    const loaded = await mapWorkers('readExport', paths, jobs);
    if (new Set(loaded.map(([name]) => name)).size !== loaded.length) throw new Error('Input export filenames must have unique stems (workspace names)');
    return new Source(new Map(loaded.map(([name, data]) => [name, data])), loaded.map(([, , info]) => info));
  }
  props(identity) { return this.nodes.get(identity)?.props ?? {}; }
  kind(identity) { return this.props(identity)._docType ?? 'node'; }
  name(identity) {
    const properties = this.props(identity);
    const value = Object.hasOwn(properties, 'name') ? properties.name : '';
    if (typeof value !== 'string') throw new Error('Node name is not text: ' + identity);
    return value;
  }
  children(identity) { return this.nodes.get(identity)?.children ?? []; }
  meta(identity) { return this.props(identity)._metaNodeId; }
  tuples(identity) {
    return this.children(identity).filter(child => this.kind(child) === 'tuple' && this.children(child).length)
      .map(child => [child, this.children(child)[0], this.children(child).slice(1)]);
  }
  setting(identity, key, {meta = false} = {}) {
    return this.tuples(meta ? this.meta(identity) : identity).filter(([, field]) => field === key).flatMap(([, , values]) => values);
  }
  tags(identity) {
    if (!this.tagCache.has(identity)) this.tagCache.set(identity, this.setting(identity, 'SYS_A13', {meta: true}));
    return this.tagCache.get(identity);
  }
  views(identity) { return this.setting(identity, 'SYS_A16', {meta: true}).filter(value => this.kind(value) === 'viewDef'); }
  lineage(identity) {
    if (this.lineages.has(identity)) return this.lineages.get(identity);
    const found = [], seen = new Set();
    let current = identity;
    while (this.nodes.has(current) && !this.lineages.has(current)) {
      if (seen.has(current)) throw new Error('Cyclic source ownership at ' + current);
      seen.add(current);
      found.push(current);
      current = this.props(current)._ownerId;
    }
    let suffix = this.lineages.get(current) ?? [];
    for (const ancestor of found.reverse()) {
      suffix = [ancestor, ...suffix];
      this.lineages.set(ancestor, suffix);
    }
    return this.lineages.get(identity) ?? [];
  }
  trashed(identity) { return this.lineage(identity).some(ancestor => ancestor.endsWith('_TRASH')); }
  active(identity) {
    if (!this.activeCache.has(identity)) {
      const lineage = this.lineage(identity);
      this.activeCache.set(identity, !lineage.some(ancestor => ancestor.endsWith('_TRASH'))
        && lineage.some(ancestor => this.kind(ancestor) === 'home' || /_(STASH|SCHEMA|SEARCHES|CAPTURE_INBOX)$/.test(ancestor)));
    }
    return this.activeCache.get(identity);
  }
  calendarDate(identity) {
    for (const value of this.setting(identity, 'SYS_A82', {meta: true})) {
      const dates = datesIn(this.name(value));
      if (dates.length) return dates[0].dateTimeString ?? null;
    }
    const name = this.name(identity);
    return this.kind(identity) === 'journalPart' && /^\d{4}-\d{2}-\d{2}/.test(name) ? name.slice(0, 10) : null;
  }
  dayContext(identity) {
    if (!this.days.has(identity)) {
      let day = null;
      for (const ancestor of [...this.lineage(identity)].reverse()) {
        if (this.days.has(ancestor)) day = this.days.get(ancestor);
        else {
          day = isoDay(this.calendarDate(ancestor)) ?? day;
          this.days.set(ancestor, day);
        }
      }
    }
    return this.days.get(identity) ?? null;
  }
  archive(identity) {
    const pending = [identity], found = new Map();
    while (pending.length) {
      const current = pending.pop();
      if (found.has(current) || !this.nodes.has(current)) continue;
      found.set(current, this.nodes.get(current));
      extend(pending, this.owned.get(current) ?? []);
      if (this.meta(current)) pending.push(this.meta(current));
    }
    return [...found.values()];
  }
}
export class Block {
  constructor(uuid, text, sourceId = null, properties = {}, children = []) {
    Object.assign(this, {uuid, text, sourceId, properties, children});
  }
}
export class Page {
  constructor(name, path, kind, sourceIds = [], properties = {}, blocks = []) {
    Object.assign(this, {name, path, kind, sourceIds, properties, blocks});
  }
}
export function safeProse(text) {
  let fence = null;
  const sourceLines = text.replace(/\r\n?/g, '\n').split('\n');
  return sourceLines.map((original, index) => {
    let line = original;
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const token = marker[1];
      if (fence === null) {
        const closing = new RegExp('^\\s*' + token[0] + '{' + token.length + ',}\\s*$');
        if (sourceLines.slice(index + 1).some(candidate => closing.test(candidate))) fence = token;
        else line = line.replace(/^(\s*)/, '$1\\');
      } else if (token[0] === fence[0] && token.length >= fence.length) fence = null;
    } else if (fence === null) {
      const property = line.match(/^(\s*)([^\s:]+)::(?:\s|$)/);
      if (property) {
        const at = property[1].length + property[2].length;
        line = line.slice(0, at + 1) + '\\' + line.slice(at + 1);
      } else if (index && /^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s)/.test(line)) line = line.replace(/^(\s*)/, '$1\\');
      else if (/^\s*(?:---|\*\*\*)\s*$/.test(line)) line = '\\' + line;
    }
    return line;
  }).join('\n');
}
export function propertyLines(properties) {
  return Object.entries(properties).map(([key, value]) => {
    if (!/^[^\s:]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid single-line property ' + JSON.stringify(key));
    return key + '::' + (value ? ' ' + value : '');
  });
}
export function serializePage(page) {
  const lines = [...propertyLines({title: page.name, ...page.properties}), ''];
  const expected = [];
  function append(block, depth, parent) {
    if (depth >= 128) throw new Error("Tine's outline depth limit (128) exceeded by " + block.uuid);
    const textLines = block.text.split('\n');
    const prefix = '\t'.repeat(depth);
    lines.push(prefix + '- ' + textLines[0]);
    const properties = {id: block.uuid, ...block.properties};
    const content = textLines.slice(1);
    const metadata = propertyLines(properties);
    const fenced = /^\s*(?:`{3,}|~{3,}|:[A-Z_-]+:\s*$)/.test(textLines[0]);
    for (const value of fenced ? [...content, ...metadata] : [...metadata, ...content]) lines.push(prefix + '  ' + value);
    expected.push({uuid: block.uuid, source_id: block.sourceId, page: page.name, path: page.path, parent, depth,
      text: block.text, properties, children: block.children.map(child => child.uuid)});
    for (const child of block.children) append(child, depth + 1, block.uuid);
  }
  for (const block of page.blocks) append(block, 0, null);
  return [page.path, lines.join('\n') + '\n', expected];
}
