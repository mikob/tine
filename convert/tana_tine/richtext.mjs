/** Tana inline HTML to Markdown, preserving node/date links and labels. */

import { Tokenizer, QuoteType } from "htmlparser2";
import { decodeHTML, decodeHTMLAttribute } from "entities";

// Match source whitespace: ECMAScript \s adds BOM and omits NEL/separators.
const SOURCE_WHITESPACE = /[\p{White_Space}\u001c-\u001f]/u;
const SOURCE_URL = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|mailto:|www\.)[^\p{White_Space}\u001c-\u001f<>]+/u;

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

export class RichText {
  static MARKERS = { b: "**", strong: "**", em: "*", i: "*", s: "~~", strike: "~~", del: "~~", mark: "==", code: "`" };
  static VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr"]);

  constructor(nodeReference, dateReference, { plain = false, assetReference = null } = {}) {
    this.nodeReference = nodeReference;
    this.dateReference = dateReference;
    this.plain = plain;
    this.assetReference = assetReference;
    this.parts = [];
    this.stack = [];
    this.suppressed = 0;
  }

  startTag(tag, attrs, raw) {
    let ending = "";
    let suppress = false;
    if (this.suppressed) {
      suppress = true;
    } else if (Object.hasOwn(attrs, "data-inlineref-node")) {
      this.parts.push(this.nodeReference(attrs["data-inlineref-node"], this.plain));
      suppress = true;
    } else if (Object.hasOwn(attrs, "data-inlineref-date")) {
      this.parts.push(this.dateReference(JSON.parse(decodeHTML(attrs["data-inlineref-date"])), this.plain));
      suppress = true;
    } else if (tag === "a") {
      if (!this.plain) {
        const target = Object.hasOwn(attrs, "href") ? attrs.href : "";
        this.parts.push("[");
        ending = `](<${target.replaceAll(">", "%3E").replaceAll("\n", "%0A")}>)`;
      }
    } else if (tag === "img") {
      const target = Object.hasOwn(attrs, "src") ? attrs.src : "";
      const label = Object.hasOwn(attrs, "alt") ? attrs.alt : "";
      this.parts.push(this.plain ? label : this.assetReference ? this.assetReference(target, label, true) : `![${label}](<${target}>)`);
    } else if (tag === "br" || tag === "hr") {
      this.parts.push("\n");
    } else if (["p", "div", "li", "pre"].includes(tag)) {
      if (this.parts.length && !this.parts.at(-1).endsWith("\n")) this.parts.push("\n");
      ending = "\n";
    } else if (Object.hasOwn(RichText.MARKERS, tag) && !this.plain) {
      let marker = RichText.MARKERS[tag];
      if (["b", "strong"].includes(tag) && (Object.hasOwn(attrs, "style") ? attrs.style : "").includes("font-weight: normal")) marker = "";
      this.parts.push(marker);
      ending = marker;
    } else if (tag === "script" || tag === "style") {
      // Source exports are data. Preserve the literal element as text.
      this.parts.push(escapeHtml(raw));
      ending = escapeHtml(`</${tag}>`);
    }
    if (!RichText.VOID.has(tag)) {
      this.stack.push([tag, ending, suppress]);
      this.suppressed += Number(suppress);
    }
  }

  endTag(tag) {
    const position = this.stack.findLastIndex(([name]) => name === tag);
    if (position < 0) return;
    while (this.stack.length > position) {
      const [, ending, suppress] = this.stack.pop();
      this.suppressed -= Number(suppress);
      if (!this.suppressed) this.parts.push(ending);
    }
  }

  data(value) {
    if (!this.suppressed) this.parts.push(value);
  }

  convert(value) {
    let tag;
    let tagStart;
    let attributes;
    let attribute;
    let attributeValue;
    let rawText = false;
    const open = (end, selfClosing) => {
      this.startTag(tag, attributes, value.slice(tagStart, end + 1));
      if (selfClosing) {
        if (!RichText.VOID.has(tag)) this.endTag(tag);
      } else {
        rawText = ["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext"].includes(tag);
      }
    };
    // Token events preserve source nesting and duplicate attributes without
    // browser-style implied closures. Raw text remains literal source data.
    const tokenizer = new Tokenizer({ decodeEntities: false, recognizeSelfClosing: true }, {
        onopentagname: (start, end) => {
          tag = value.slice(start, end).toLowerCase();
          tagStart = start - 1;
          attributes = Object.create(null);
        },
        onattribname: (start, end) => {
          attribute = value.slice(start, end).toLowerCase();
          attributeValue = "";
        },
        onattribdata: (start, end) => { attributeValue += value.slice(start, end); },
        onattribentity: (codepoint) => { attributeValue += String.fromCodePoint(codepoint); },
        onattribend: (quote) => { attributes[attribute] = quote === QuoteType.NoValue ? null : decodeHTMLAttribute(attributeValue); },
        onopentagend: (end) => open(end, false),
        onselfclosingtag: (end) => open(end, true),
        onclosetag: (start, end) => {
          const closing = value.indexOf(">", end);
          if (closing !== -1) {
            this.endTag(value.slice(start, end).toLowerCase());
            rawText = false;
          }
        },
        ontext: (start, end) => {
          // An unfinished special-tag prefix is not a completed source tag.
          if (!rawText && end === value.length && value[start - 1] === "<" && /^[A-Za-z][^>]*$/.test(value.slice(start, end))) return;
          const content = value.slice(start, end);
          this.data(rawText ? content : decodeHTML(content));
        },
        ontextentity: (codepoint) => this.data(String.fromCodePoint(codepoint)),
        oncomment: (start, end, offset) => {
          // Processing instructions are ignored by the source HTML parser.
          if (value[start] !== "?" || value[start - 1] !== "<") {
            this.data(`&lt;!--${value.slice(start, end - offset)}--&gt;`);
          }
        },
        oncdata: () => {},
        ondeclaration: () => {},
        onprocessinginstruction: () => {},
        onend: () => {},
    });
    tokenizer.write(value);
    tokenizer.end();
    while (this.stack.length) this.endTag(this.stack.at(-1)[0]);
    return this.parts.join("");
  }
}

export function codeFence(value, language = "") {
  let length = 3;
  for (const [run] of value.matchAll(/`+/g)) length = Math.max(length, run.length + 1);
  const fence = "`".repeat(length);
  return `${fence}${language.replace(/[^a-zA-Z0-9_+.-]/g, "")}\n${value}\n${fence}`;
}

function balancedEnd(value, start, opening, closing) {
  let depth = 1;
  let position = start + opening.length;
  while (position < value.length) {
    if (value[position] === "\\") {
      position += 2;
    } else if (value.startsWith(opening, position)) {
      depth += 1;
      position += opening.length;
    } else if (value.startsWith(closing, position)) {
      depth -= 1;
      position += closing.length;
      if (!depth) return position;
    } else {
      position += 1;
    }
  }
  return null;
}

/** Preserve authored hashtags as prose; real supertags are appended separately. */
export function escapeSourceHashtags(value) {
  const output = [];
  let position = 0;
  while (position < value.length) {
    const tail = value.slice(position);
    let end = null;
    if (position === 0 || value[position - 1] === "\n") {
      const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n/.exec(tail);
      if (fence) {
        const token = fence[1];
        const closing = new RegExp(`^[ \\t]*${token[0]}{${token.length},}[ \\t]*(?:\\n|$)`, "m").exec(tail.slice(fence[0].length));
        if (closing) end = position + fence[0].length + closing.index + closing[0].length;
      }
      if (end === null) {
        const heading = /^[ \t]*#{1,6}(?=[ \t])/.exec(tail);
        if (heading) end = position + heading[0].length;
      }
    }
    if (end === null && value[position] === "\\" && position + 1 < value.length) end = position + 2;
    if (end === null && value[position] === "`") {
      const run = /^`+/.exec(tail)[0];
      const closing = new RegExp(`(?<!\x60)${run}(?!\x60)`).exec(tail.slice(run.length));
      if (closing) end = position + run.length + closing.index + closing[0].length;
    }
    if (end === null && value.startsWith("[[", position)) end = balancedEnd(value, position, "[[", "]]");
    if (end === null && value[position] === "[") {
      const labelEnd = balancedEnd(value, position, "[", "]");
      if (labelEnd !== null && labelEnd < value.length) {
        if (value[labelEnd] === "(") end = balancedEnd(value, labelEnd, "(", ")");
        else if (value[labelEnd] === "[") end = balancedEnd(value, labelEnd, "[", "]");
      }
    }
    if (end === null) {
      const url = SOURCE_URL.exec(tail);
      if (url) end = position + url[0].length;
    }
    if (end !== null) {
      output.push(value.slice(position, end));
      position = end;
      continue;
    }
    const character = value[position];
    if (character === "#" && position + 1 < value.length && !SOURCE_WHITESPACE.test(value[position + 1]) && !"#,!?'\":".includes(value[position + 1])) output.push("\\");
    output.push(character);
    position += 1;
  }
  return output.join("");
}
