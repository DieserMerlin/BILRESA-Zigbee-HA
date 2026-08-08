/**
 * <bilresa-action-editor> — dialog for one action sequence.
 *
 * It prefers Home Assistant's own `ha-automation-action`, so the user gets the
 * exact editor they know from automations. That element only exists once the
 * frontend has loaded the automation chunk, so its presence is checked at
 * runtime and every access is guarded; when it is missing or throws, the dialog
 * falls back to a YAML text area.
 *
 * The fallback carries its own tiny YAML reader and writer: the panel ships
 * without a build step and must work offline, so no library can be pulled in.
 * It covers the subset Home Assistant script sequences use — block mappings and
 * sequences, flow collections, quoted and block scalars — and reports the line
 * of a syntax error. The authoritative check stays on the server, which
 * validates the sequence and answers with `invalid_sequence`.
 */

import { sharedStyles } from "./styles.js";
import { describeError, formatAction, setBinding } from "./api.js";

const SCRIPT_MODES = [
  ["single", "Einfach — ein zweiter Druck wird ignoriert, solange die Folge läuft"],
  ["restart", "Neu starten — ein zweiter Druck beginnt von vorn"],
  ["queued", "Einreihen — jeder Druck läuft nacheinander"],
  ["parallel", "Parallel — jeder Druck startet einen eigenen Lauf"],
];

const ICONS = {
  close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  alert: "M13 14h-2V9h2m0 9h-2v-2h2M1 21h22L12 2z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  code: "M14.6 16.6 19.2 12l-4.6-4.6L16 6l6 6-6 6zm-5.2 0L4.8 12l4.6-4.6L8 6l-6 6 6 6z",
  list: "M3 5h2v2H3zm0 6h2v2H3zm0 6h2v2H3zM7 5h14v2H7zm0 6h14v2H7zm0 6h14v2H7z",
};

/* ------------------------------------------------------------------- YAML -- */

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `Zeile ${line}: ${message}` : message);
    this.name = "YamlError";
    this.line = line || 0;
  }
}

/** Drop a trailing `# comment`, respecting quotes. */
function stripComment(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === '"') inDouble = false;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

function parsePlain(text) {
  const value = text.trim();
  if (value === "" || value === "~" || /^(null|Null|NULL)$/.test(value)) return null;
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(value)) return true;
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(value)) return false;
  if (/^0x[0-9a-fA-F]+$/.test(value)) return parseInt(value, 16);
  if (/^[-+]?\d+$/.test(value)) {
    const number = parseInt(value, 10);
    return Number.isSafeInteger(number) ? number : value;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return Number(value);
  if (/^[-+]?\d+[eE][-+]?\d+$/.test(value)) return Number(value);
  return value;
}

function skipFlowSpace(ctx) {
  while (ctx.i < ctx.s.length && /\s/.test(ctx.s[ctx.i])) ctx.i += 1;
}

function readEscape(ctx) {
  const esc = ctx.s[ctx.i];
  ctx.i += 1;
  switch (esc) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "0":
      return "\0";
    case '"':
      return '"';
    case "'":
      return "'";
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "u": {
      const hex = ctx.s.slice(ctx.i, ctx.i + 4);
      ctx.i += 4;
      const code = parseInt(hex, 16);
      if (Number.isNaN(code)) throw new YamlError("Ungültige \\u-Sequenz.", ctx.line);
      return String.fromCharCode(code);
    }
    default:
      return esc === undefined ? "" : esc;
  }
}

function readQuoted(ctx) {
  const quote = ctx.s[ctx.i];
  ctx.i += 1;
  let out = "";
  while (ctx.i < ctx.s.length) {
    const char = ctx.s[ctx.i];
    if (quote === "'") {
      if (char === "'") {
        if (ctx.s[ctx.i + 1] === "'") {
          out += "'";
          ctx.i += 2;
          continue;
        }
        ctx.i += 1;
        return out;
      }
      out += char;
      ctx.i += 1;
      continue;
    }
    if (char === "\\") {
      ctx.i += 1;
      out += readEscape(ctx);
      continue;
    }
    if (char === '"') {
      ctx.i += 1;
      return out;
    }
    out += char;
    ctx.i += 1;
  }
  throw new YamlError("Ein Anführungszeichen wurde nicht geschlossen.", ctx.line);
}

function readFlowNode(ctx) {
  skipFlowSpace(ctx);
  const char = ctx.s[ctx.i];
  if (char === undefined) throw new YamlError("Der Wert ist unvollständig.", ctx.line);
  if (char === "[") return readFlowSequence(ctx);
  if (char === "{") return readFlowMapping(ctx);
  if (char === '"' || char === "'") return readQuoted(ctx);
  const start = ctx.i;
  while (ctx.i < ctx.s.length && !",]}".includes(ctx.s[ctx.i])) ctx.i += 1;
  return parsePlain(ctx.s.slice(start, ctx.i));
}

function readFlowSequence(ctx) {
  ctx.i += 1;
  const out = [];
  for (;;) {
    skipFlowSpace(ctx);
    if (ctx.i >= ctx.s.length) throw new YamlError("Es fehlt eine schließende Klammer „]“.", ctx.line);
    if (ctx.s[ctx.i] === "]") {
      ctx.i += 1;
      return out;
    }
    out.push(readFlowNode(ctx));
    skipFlowSpace(ctx);
    if (ctx.s[ctx.i] === ",") {
      ctx.i += 1;
      continue;
    }
    if (ctx.s[ctx.i] === "]") {
      ctx.i += 1;
      return out;
    }
    throw new YamlError("Erwartet wurde „,“ oder „]“.", ctx.line);
  }
}

function readFlowMapping(ctx) {
  ctx.i += 1;
  const out = {};
  for (;;) {
    skipFlowSpace(ctx);
    if (ctx.i >= ctx.s.length) throw new YamlError("Es fehlt eine schließende Klammer „}“.", ctx.line);
    if (ctx.s[ctx.i] === "}") {
      ctx.i += 1;
      return out;
    }
    let key;
    const char = ctx.s[ctx.i];
    if (char === '"' || char === "'") {
      key = readQuoted(ctx);
    } else {
      const start = ctx.i;
      while (ctx.i < ctx.s.length && !":,}".includes(ctx.s[ctx.i])) ctx.i += 1;
      key = ctx.s.slice(start, ctx.i).trim();
    }
    skipFlowSpace(ctx);
    if (ctx.s[ctx.i] !== ":") throw new YamlError("In geschweiften Klammern fehlt ein „:“.", ctx.line);
    ctx.i += 1;
    out[String(key)] = readFlowNode(ctx);
    skipFlowSpace(ctx);
    if (ctx.s[ctx.i] === ",") {
      ctx.i += 1;
      continue;
    }
    if (ctx.s[ctx.i] === "}") {
      ctx.i += 1;
      return out;
    }
    throw new YamlError("Erwartet wurde „,“ oder „}“.", ctx.line);
  }
}

function parseScalarText(text, line) {
  const value = String(text).trim();
  if (!value) return null;
  const first = value[0];
  if (first === "&" || first === "*") {
    throw new YamlError("Anker und Verweise werden hier nicht unterstützt.", line);
  }
  if (first === '"' || first === "'" || first === "[" || first === "{") {
    const ctx = { s: value, i: 0, line };
    const parsed = readFlowNode(ctx);
    skipFlowSpace(ctx);
    if (ctx.i < ctx.s.length) throw new YamlError("Nach dem Wert steht unerwarteter Text.", line);
    return parsed;
  }
  return parsePlain(value);
}

/** Indentation based reader for the YAML subset script sequences need. */
class YamlParser {
  constructor(text) {
    this.lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
    this.pos = 0;
  }

  atEnd() {
    return this.pos >= this.lines.length;
  }

  isBlank(line) {
    const trimmed = line.trim();
    return !trimmed || trimmed.startsWith("#");
  }

  skipBlank() {
    while (!this.atEnd() && this.isBlank(this.lines[this.pos])) this.pos += 1;
  }

  indentOf(line) {
    let i = 0;
    while (i < line.length && line[i] === " ") i += 1;
    if (line[i] === "\t") {
      throw new YamlError("Tabulatoren sind in YAML nicht erlaubt, bitte Leerzeichen nutzen.", this.pos + 1);
    }
    return i;
  }

  content(line, indent) {
    return stripComment(line.slice(indent)).trimEnd();
  }

  parse() {
    this.skipBlank();
    if (this.atEnd()) return null;
    if (this.lines[this.pos].trim() === "---") {
      this.pos += 1;
      this.skipBlank();
      if (this.atEnd()) return null;
    }
    const value = this.parseNode(this.indentOf(this.lines[this.pos]));
    this.skipBlank();
    if (!this.atEnd() && this.lines[this.pos].trim() !== "...") {
      throw new YamlError("Unerwarteter Inhalt — stimmt die Einrückung?", this.pos + 1);
    }
    return value;
  }

  parseNode(indent) {
    this.skipBlank();
    if (this.atEnd()) return null;
    const line = this.lines[this.pos];
    const ind = this.indentOf(line);
    if (ind < indent) return null;
    const content = this.content(line, ind);
    if (/^-(\s|$)/.test(content)) return this.parseSequence(ind);
    if (this.splitKey(content)) return this.parseMapping(ind);
    this.pos += 1;
    return this.parseValue(content, ind);
  }

  parseSequence(indent) {
    const items = [];
    for (;;) {
      this.skipBlank();
      if (this.atEnd()) break;
      const line = this.lines[this.pos];
      const ind = this.indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new YamlError("Unerwartete Einrückung.", this.pos + 1);
      const content = this.content(line, ind);
      if (!/^-(\s|$)/.test(content)) break;
      const rest = line.slice(ind + 1);
      if (!stripComment(rest).trim()) {
        this.pos += 1;
        items.push(this.parseChild(ind));
        continue;
      }
      // Rewrite the dash as a space: the item is simply a node one column in.
      const rewritten = `${line.slice(0, ind)} ${rest}`;
      this.lines[this.pos] = rewritten;
      items.push(this.parseNode(this.indentOf(rewritten)));
    }
    return items;
  }

  parseMapping(indent) {
    const map = {};
    for (;;) {
      this.skipBlank();
      if (this.atEnd()) break;
      const line = this.lines[this.pos];
      const ind = this.indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new YamlError("Unerwartete Einrückung.", this.pos + 1);
      const content = this.content(line, ind);
      if (/^-(\s|$)/.test(content)) break;
      const split = this.splitKey(content);
      if (!split) throw new YamlError("Erwartet wurde „schlüssel: wert“.", this.pos + 1);
      this.pos += 1;
      if (split.value === "") map[split.key] = this.parseChild(ind);
      else map[split.key] = this.parseValue(split.value, ind);
    }
    return map;
  }

  /** The value of a key lives either indented below it or as a sequence next to it. */
  parseChild(parentIndent) {
    this.skipBlank();
    if (this.atEnd()) return null;
    const line = this.lines[this.pos];
    const ind = this.indentOf(line);
    if (ind > parentIndent) return this.parseNode(ind);
    if (ind === parentIndent && /^-(\s|$)/.test(this.content(line, ind))) {
      return this.parseSequence(ind);
    }
    return null;
  }

  parseValue(text, indent) {
    const block = /^([|>])([+-]?)(\d*)\s*$/.exec(text);
    if (block) return this.parseBlockScalar(block[1], block[2], indent);
    return parseScalarText(text, this.pos);
  }

  parseBlockScalar(style, chomp, parentIndent) {
    const collected = [];
    let base = -1;
    while (!this.atEnd()) {
      const line = this.lines[this.pos];
      if (!line.trim()) {
        collected.push("");
        this.pos += 1;
        continue;
      }
      const ind = this.indentOf(line);
      if (ind <= parentIndent) break;
      if (base < 0) base = ind;
      if (ind < base) break;
      collected.push(line.slice(base));
      this.pos += 1;
    }
    while (collected.length && collected[collected.length - 1] === "") collected.pop();

    let text;
    if (style === "|") {
      text = collected.join("\n");
    } else {
      const paragraphs = [];
      let buffer = [];
      for (const line of collected) {
        if (line === "") {
          paragraphs.push(buffer.join(" "));
          buffer = [];
        } else {
          buffer.push(line.trim());
        }
      }
      paragraphs.push(buffer.join(" "));
      text = paragraphs.join("\n");
    }
    if (chomp !== "-" && text !== "") text += "\n";
    return text;
  }

  /** Split `key: value`, ignoring colons inside quotes or flow collections. */
  splitKey(content) {
    let inSingle = false;
    let inDouble = false;
    let depth = 0;
    for (let i = 0; i < content.length; i += 1) {
      const char = content[i];
      if (inSingle) {
        if (char === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (char === "\\") {
          i += 1;
          continue;
        }
        if (char === '"') inDouble = false;
        continue;
      }
      if (char === "'") {
        inSingle = true;
        continue;
      }
      if (char === '"') {
        inDouble = true;
        continue;
      }
      if (char === "[" || char === "{") {
        depth += 1;
        continue;
      }
      if (char === "]" || char === "}") {
        depth -= 1;
        continue;
      }
      if (char === ":" && depth === 0) {
        const next = content[i + 1];
        if (next === undefined || next === " ") {
          const rawKey = content.slice(0, i).trim();
          if (!rawKey) return null;
          const key = parseScalarText(rawKey, this.pos + 1);
          return { key: String(key), value: content.slice(i + 1).trim() };
        }
      }
    }
    return null;
  }
}

export function parseYaml(text) {
  return new YamlParser(text).parse();
}

function mustQuote(text) {
  if (text === "") return true;
  if (text !== text.trim()) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true;
  if (text.includes(": ") || text.includes(" #")) return true;
  if (text.endsWith(":")) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return true;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return true;
  return false;
}

function quoteText(text) {
  if (!text.includes("'")) return `'${text}'`;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Scalar on one line, or null when the value needs a block of its own. */
function inlineScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") {
    if (value.includes("\n")) return null;
    return mustQuote(value) ? quoteText(value) : value;
  }
  if (Array.isArray(value)) return value.length ? null : "[]";
  if (typeof value === "object") return Object.keys(value).length ? null : "{}";
  return String(value);
}

function dumpBlock(value, indent) {
  const pad = " ".repeat(indent);
  const lines = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      const inline = inlineScalar(item);
      if (inline !== null) {
        lines.push(`${pad}- ${inline}`);
        continue;
      }
      if (typeof item === "string") {
        lines.push(`${pad}- |-`);
        for (const part of item.split("\n")) lines.push(`${pad}    ${part}`);
        continue;
      }
      const child = dumpBlock(item, indent + 2).split("\n");
      const first = child.shift() || "";
      lines.push(`${pad}- ${first.slice(indent + 2)}`);
      for (const part of child) lines.push(part);
    }
    return lines.join("\n");
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const rawKey = String(key);
      const keyText = mustQuote(rawKey) ? quoteText(rawKey) : rawKey;
      const inline = inlineScalar(item);
      if (inline !== null) {
        lines.push(`${pad}${keyText}: ${inline}`);
        continue;
      }
      if (typeof item === "string") {
        lines.push(`${pad}${keyText}: |-`);
        for (const part of item.split("\n")) lines.push(`${pad}  ${part}`);
        continue;
      }
      lines.push(`${pad}${keyText}:`);
      lines.push(dumpBlock(item, indent + 2));
    }
    return lines.join("\n");
  }

  return `${pad}${inlineScalar(value)}`;
}

export function dumpYaml(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value) && !value.length) return "";
  const text = dumpBlock(value, 0);
  return text ? `${text}\n` : "";
}

/* ---------------------------------------------------------------- helpers -- */

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
      else if (key.startsWith("on") && typeof value === "function")
        node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child && child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name, extraClass) {
  return h("span", {
    class: extraClass ? `icon ${extraClass}` : "icon",
    "aria-hidden": "true",
    html: `<svg viewBox="0 0 24 24"><path d="${ICONS[name] || ""}"/></svg>`,
  });
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return value;
  }
}

/* ---------------------------------------------------------------- element -- */

let dialogCounter = 0;

class BilresaActionEditor extends HTMLElement {
  static get properties() {
    return { hass: {}, subentryId: {}, modeKey: {}, action: {}, binding: {}, context: {} };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._uid = `bil-dlg-${++dialogCounter}`;
    this._hass = null;
    this._subentryId = "";
    this._modeKey = "";
    this._action = "";
    this._context = "";
    this._bindingInput = null;

    this._sequence = [];
    this._scriptMode = "single";
    this._mode = "yaml";
    this._yamlText = "";
    this._yamlEditor = null;
    this._visualEl = null;
    this._visualBroken = false;
    this._dirty = false;
    this._saving = false;
    this._confirmClose = false;
    this._confirmEmpty = false;
    this._returnFocus = null;
    this._previousOverflow = "";
    this._visualCheck = null;

    this._onKeydown = (event) => this._handleKeydown(event);
  }

  /* --------------------------------------------------------- properties -- */

  set hass(hass) {
    this._hass = hass;
    if (this._visualEl) this._visualEl.hass = hass;
    if (this._yamlEditor) this._yamlEditor.hass = hass;
  }

  get hass() {
    return this._hass;
  }

  set subentryId(value) {
    this._subentryId = String(value || "");
  }

  get subentryId() {
    return this._subentryId;
  }

  set modeKey(value) {
    this._modeKey = String(value || "");
  }

  get modeKey() {
    return this._modeKey;
  }

  set action(value) {
    this._action = String(value || "");
  }

  get action() {
    return this._action;
  }

  set context(value) {
    this._context = String(value || "");
  }

  get context() {
    return this._context;
  }

  set binding(value) {
    this._bindingInput = value && typeof value === "object" ? value : null;
  }

  get binding() {
    return this._bindingInput;
  }

  /* ---------------------------------------------------------- lifecycle -- */

  connectedCallback() {
    this._returnFocus = this._findReturnFocus();
    this._prepare();
    this._render();
    this._lockScroll();
    this.shadowRoot.addEventListener("keydown", this._onKeydown);
    requestAnimationFrame(() => this._focusFirst());
  }

  disconnectedCallback() {
    this.shadowRoot.removeEventListener("keydown", this._onKeydown);
    if (this._visualCheck) clearTimeout(this._visualCheck);
    this._visualCheck = null;
    this._unlockScroll();
    const target = this._returnFocus;
    this._returnFocus = null;
    if (target && typeof target.focus === "function" && target.isConnected) {
      try {
        target.focus();
      } catch (err) {
        // The element may have been re-rendered away in the meantime.
      }
    }
  }

  _findReturnFocus() {
    const root = this.getRootNode();
    const active = root && root.activeElement ? root.activeElement : document.activeElement;
    return active && active !== this ? active : null;
  }

  _lockScroll() {
    try {
      this._previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    } catch (err) {
      this._previousOverflow = "";
    }
  }

  _unlockScroll() {
    try {
      document.body.style.overflow = this._previousOverflow || "";
    } catch (err) {
      // Nothing to restore.
    }
  }

  _prepare() {
    const binding = this._bindingInput || {};
    const sequence = Array.isArray(binding.sequence) ? clone(binding.sequence) : [];
    this._sequence = sequence;
    this._yamlText = dumpYaml(sequence);
    this._scriptMode =
      typeof binding.script_mode === "string" && SCRIPT_MODES.some(([id]) => id === binding.script_mode)
        ? binding.script_mode
        : this._action === "wheel"
          ? "restart"
          : "single";
    this._mode = this._visualAvailable() ? "visual" : "yaml";
  }

  _visualAvailable() {
    if (this._visualBroken) return false;
    try {
      return Boolean(customElements.get("ha-automation-action"));
    } catch (err) {
      return false;
    }
  }

  /* ------------------------------------------------------------- render -- */

  _render() {
    const root = this.shadowRoot;
    root.textContent = "";

    const style = document.createElement("style");
    style.textContent = `${sharedStyles}\n${DIALOG_STYLES}`;
    root.append(style);

    this._error = h("div", { class: "dialog-error", role: "alert", hidden: true });
    this._bodyHost = h("div", { class: "dialog-body" });

    const title = `${formatAction(this._action)} belegen`;
    const heading = h("h2", { id: `${this._uid}-title`, class: "dialog-title", text: title });
    const subtitle = h("p", { class: "dialog-sub muted small", text: this._context });

    const closeBtn = h(
      "button",
      {
        type: "button",
        class: "icon-btn",
        "aria-label": "Dialog schließen",
        title: "Schließen",
        onclick: () => this._requestClose(),
      },
      icon("close")
    );

    const header = h(
      "header",
      { class: "dialog-head" },
      h("div", { class: "dialog-titles" }, heading, subtitle),
      h("div", { class: "spacer" }),
      closeBtn
    );

    const dialog = h("div", {
      class: "dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": `${this._uid}-title`,
    });

    dialog.append(
      h("span", { class: "sentinel", tabindex: "0", "aria-hidden": "true", onfocus: () => this._wrapFocus("end") }),
      header
    );

    const switcher = this._buildSwitcher();
    if (switcher) dialog.append(switcher);

    dialog.append(this._bodyHost, this._error, this._buildFooter());
    dialog.append(
      h("span", { class: "sentinel", tabindex: "0", "aria-hidden": "true", onfocus: () => this._wrapFocus("start") })
    );

    this._dialogEl = dialog;
    this._backdrop = h(
      "div",
      {
        class: "backdrop",
        onmousedown: (event) => {
          this._pressedBackdrop = event.target === this._backdrop;
        },
        onclick: (event) => {
          if (event.target === this._backdrop && this._pressedBackdrop) this._requestClose();
          this._pressedBackdrop = false;
        },
      },
      dialog
    );

    root.append(this._backdrop);
    this._renderBody();
  }

  _buildSwitcher() {
    if (!this._visualAvailable()) return null;
    const group = h("div", { class: "switcher", role: "group", "aria-label": "Ansicht" });
    const make = (mode, label, iconName) =>
      h(
        "button",
        {
          type: "button",
          class: `switch-btn${this._mode === mode ? " is-active" : ""}`,
          "aria-pressed": this._mode === mode ? "true" : "false",
          onclick: () => this._setMode(mode),
        },
        icon(iconName),
        h("span", { text: label })
      );
    group.append(make("visual", "Visuell", "list"), make("yaml", "YAML", "code"));
    return group;
  }

  _buildFooter() {
    const select = h(
      "select",
      {
        id: `${this._uid}-script-mode`,
        onchange: (event) => {
          this._scriptMode = event.target.value;
          this._dirty = true;
          this._confirmClose = false;
        },
      },
      SCRIPT_MODES.map(([id, label]) =>
        h("option", { value: id, selected: id === this._scriptMode }, label)
      )
    );

    this._saveBtn = h(
      "button",
      { type: "button", class: "btn primary", onclick: () => this._save() },
      icon("check"),
      h("span", { text: "Speichern" })
    );

    return h(
      "footer",
      { class: "dialog-foot" },
      h(
        "div",
        { class: "field mode-field" },
        h("label", { for: `${this._uid}-script-mode`, text: "Bei erneutem Druck" }),
        select
      ),
      h("div", { class: "spacer" }),
      h(
        "button",
        { type: "button", class: "btn ghost", onclick: () => this._requestClose() },
        h("span", { text: "Abbrechen" })
      ),
      this._saveBtn
    );
  }

  _renderBody() {
    const host = this._bodyHost;
    host.textContent = "";
    this._visualEl = null;
    this._yamlEditor = null;
    this._textarea = null;
    if (this._visualCheck) {
      clearTimeout(this._visualCheck);
      this._visualCheck = null;
    }

    if (this._mode === "visual") {
      const element = this._createVisual();
      if (element) {
        this._visualEl = element;
        host.append(element);
        // If HA's editor fails to render, do not leave the user with a blank box.
        this._visualCheck = setTimeout(() => {
          this._visualCheck = null;
          if (!element.isConnected) return;
          const rendered = element.shadowRoot
            ? element.shadowRoot.childElementCount > 0
            : element.childElementCount > 0;
          if (rendered) return;
          this._visualBroken = true;
          this._mode = "yaml";
          this._yamlText = dumpYaml(this._sequence);
          this._render();
          this._showError("Der visuelle Editor von Home Assistant konnte nicht geladen werden — hier ist die YAML-Ansicht.");
        }, 1200);
        return;
      }
      this._mode = "yaml";
    }

    host.append(this._buildYamlView());
  }

  _createVisual() {
    if (!this._visualAvailable()) return null;
    try {
      const element = document.createElement("ha-automation-action");
      element.hass = this._hass;
      element.narrow = window.matchMedia("(max-width: 700px)").matches;
      element.actions = clone(this._sequence);
      element.addEventListener("value-changed", (event) => {
        event.stopPropagation();
        const value = event.detail ? event.detail.value : undefined;
        this._sequence = Array.isArray(value) ? value : value ? [value] : [];
        this._dirty = true;
        this._confirmClose = false;
        this._confirmEmpty = false;
        this._clearError();
      });
      return element;
    } catch (err) {
      this._visualBroken = true;
      return null;
    }
  }

  _buildYamlView() {
    const wrap = h("div", { class: "yaml-wrap" });
    const editor = this._createHaYamlEditor();
    if (editor) {
      this._yamlEditor = editor;
      wrap.append(editor);
    } else {
      this._textarea = h("textarea", {
        class: "yaml-area mono",
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
        rows: "16",
        "aria-label": "Aktionsfolge als YAML",
        placeholder: "- action: light.turn_on\n  target:\n    entity_id: light.kueche",
        oninput: (event) => {
          this._yamlText = event.target.value;
          this._dirty = true;
          this._confirmClose = false;
          this._confirmEmpty = false;
          this._clearError();
        },
        onkeydown: (event) => {
          if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey) return;
          // Tab indents instead of leaving the field; Escape still gets you out.
          event.preventDefault();
          const area = event.target;
          const start = area.selectionStart;
          const end = area.selectionEnd;
          area.value = `${area.value.slice(0, start)}  ${area.value.slice(end)}`;
          area.selectionStart = start + 2;
          area.selectionEnd = start + 2;
          this._yamlText = area.value;
          this._dirty = true;
        },
      });
      this._textarea.value = this._yamlText;
      wrap.append(this._textarea);
    }

    wrap.append(
      h("p", {
        class: "yaml-hint muted small",
        text:
          "Eine Liste von Schritten, genau wie im Automations-Editor. Home Assistant prüft die Folge beim Speichern.",
      })
    );
    return wrap;
  }

  _createHaYamlEditor() {
    let Ctor = null;
    try {
      Ctor = customElements.get("ha-yaml-editor") || null;
    } catch (err) {
      Ctor = null;
    }
    if (!Ctor) return null;
    try {
      const element = document.createElement("ha-yaml-editor");
      element.hass = this._hass;
      element.label = "Aktionsfolge als YAML";
      element.defaultValue = clone(this._sequence);
      this._yamlValue = clone(this._sequence);
      this._yamlValid = true;
      element.addEventListener("value-changed", (event) => {
        event.stopPropagation();
        const detail = event.detail || {};
        this._dirty = true;
        this._confirmClose = false;
        this._confirmEmpty = false;
        if (detail.isValid === false) {
          this._yamlValid = false;
          return;
        }
        this._yamlValid = true;
        this._yamlValue = detail.value;
        this._clearError();
      });
      return element;
    } catch (err) {
      return null;
    }
  }

  /* ---------------------------------------------------------- behaviour -- */

  _setMode(mode) {
    if (mode === this._mode) return;
    if (mode === "yaml") {
      this._yamlText = dumpYaml(this._sequence);
      this._mode = "yaml";
      this._render();
      return;
    }
    let sequence;
    try {
      sequence = this._sequenceFromYaml();
    } catch (err) {
      this._showError(err.message);
      return;
    }
    this._sequence = sequence;
    this._mode = "visual";
    this._render();
  }

  _sequenceFromYaml() {
    if (this._yamlEditor) {
      if (this._yamlValid === false) {
        throw new YamlError("Die YAML-Struktur ist nicht lesbar. Bitte die Einrückung prüfen.");
      }
      const value = this._yamlValue;
      return this._normalise(value);
    }
    const text = this._textarea ? this._textarea.value : this._yamlText;
    const value = parseYaml(text);
    return this._normalise(value);
  }

  _normalise(value) {
    if (value === null || value === undefined) return [];
    const list = Array.isArray(value) ? value : [value];
    list.forEach((step, index) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        throw new YamlError(`Schritt ${index + 1} ist kein Aktionsobjekt (erwartet wird „schlüssel: wert“).`);
      }
    });
    return list;
  }

  _collectSequence() {
    if (this._mode === "yaml") return this._sequenceFromYaml();
    return this._normalise(this._sequence);
  }

  async _save() {
    if (this._saving) return;
    let sequence;
    try {
      sequence = this._collectSequence();
    } catch (err) {
      this._showError(err instanceof YamlError ? err.message : describeError(err));
      return;
    }

    if (!sequence.length && !this._confirmEmpty) {
      this._confirmEmpty = true;
      this._showError(
        "Die Folge ist leer — Speichern würde den Slot leeren. Noch einmal auf Speichern klicken, wenn das so gewollt ist."
      );
      return;
    }

    this._saving = true;
    this._setSaving(true);
    try {
      await setBinding(
        this._hass,
        this._subentryId,
        this._modeKey,
        this._action,
        sequence,
        this._scriptMode
      );
      this._dirty = false;
      this.dispatchEvent(
        new CustomEvent("saved", {
          bubbles: true,
          composed: true,
          detail: { mode_key: this._modeKey, action: this._action, sequence },
        })
      );
      this._close();
    } catch (err) {
      // The dialog stays open and keeps the text: the user must not retype it.
      this._showError(describeError(err));
    } finally {
      this._saving = false;
      this._setSaving(false);
    }
  }

  _setSaving(saving) {
    if (!this._saveBtn || !this._saveBtn.isConnected) return;
    this._saveBtn.disabled = saving;
    this._saveBtn.textContent = "";
    this._saveBtn.append(icon("check"), h("span", { text: saving ? "Speichert …" : "Speichern" }));
  }

  _showError(message) {
    if (!this._error) return;
    this._error.textContent = "";
    this._error.append(icon("alert"), h("span", { text: message }));
    this._error.hidden = false;
  }

  _clearError() {
    if (!this._error) return;
    this._error.hidden = true;
    this._error.textContent = "";
  }

  _requestClose() {
    if (this._saving) return;
    if (this._dirty && !this._confirmClose) {
      this._confirmClose = true;
      this._showError("Es gibt ungespeicherte Änderungen. Noch einmal schließen verwirft sie.");
      return;
    }
    this._close();
  }

  _close() {
    this.dispatchEvent(new CustomEvent("dialog-closed", { bubbles: true, composed: true }));
    this.remove();
  }

  /** Public escape hatch for the host element. */
  close() {
    this._close();
  }

  _handleKeydown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      this._requestClose();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this._save();
    }
  }

  _focusables() {
    if (!this._dialogEl) return [];
    const selector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(this._dialogEl.querySelectorAll(selector)).filter(
      (node) => !node.classList.contains("sentinel") && node.offsetParent !== null
    );
  }

  /**
   * Focus wrapping via sentinels instead of a key handler: Home Assistant's
   * editor puts its controls into nested shadow roots, which a querySelector
   * based trap cannot see.
   */
  _wrapFocus(edge) {
    const items = this._focusables();
    if (!items.length) return;
    const target = edge === "end" ? items[items.length - 1] : items[0];
    target.focus();
  }

  _focusFirst() {
    if (this._textarea) {
      this._textarea.focus();
      return;
    }
    const items = this._focusables();
    if (items.length) items[0].focus();
  }
}

/* ------------------------------------------------------------------ styles -- */

const DIALOG_STYLES = `
:host {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: block;
  background: transparent;
  min-height: 0;
}

.backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.48);
  animation: bil-fade-in 0.16s ease-out;
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(860px, 100%);
  max-height: min(88vh, 900px);
  background: var(--bil-surface);
  color: var(--bil-text);
  border-radius: var(--bil-radius-lg);
  box-shadow: var(--bil-shadow-2);
  overflow: hidden;
  animation: bil-dialog-in 0.18s ease-out;
}

.sentinel { display: block; width: 0; height: 0; overflow: hidden; }

.dialog-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: var(--bil-gap) var(--bil-gap-lg);
  border-bottom: var(--bil-border);
}

.dialog-titles { min-width: 0; }
.dialog-title { margin: 0; font-size: 18px; font-weight: 600; }
.dialog-sub { margin: 2px 0 0; overflow-wrap: anywhere; }

.switcher {
  display: flex;
  gap: 6px;
  padding: 12px var(--bil-gap-lg) 0;
}

.switch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 14px;
  border: var(--bil-border);
  border-radius: var(--bil-pill);
  background: transparent;
  color: var(--bil-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.switch-btn.is-active {
  background: var(--bil-accent);
  border-color: transparent;
  color: var(--bil-on-accent);
}

.switch-btn:focus-visible { outline: 2px solid var(--bil-accent); outline-offset: 2px; }

.dialog-body {
  flex: 1 1 auto;
  overflow: auto;
  padding: var(--bil-gap) var(--bil-gap-lg);
  -webkit-overflow-scrolling: touch;
}

.yaml-wrap { display: flex; flex-direction: column; gap: 8px; }

.yaml-area {
  width: 100%;
  min-height: 260px;
  resize: vertical;
  font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 13px;
  line-height: 1.6;
  tab-size: 2;
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}

.dialog-error {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0 var(--bil-gap-lg) var(--bil-gap);
  padding: 12px 14px;
  border-radius: var(--bil-radius-md);
  border-left: 3px solid var(--bil-error);
  background: color-mix(in srgb, var(--bil-error) 12%, var(--bil-surface));
  font-size: 13px;
}

.dialog-error .icon { color: var(--bil-error); flex: none; }
.dialog-error span { min-width: 0; overflow-wrap: anywhere; }

.dialog-foot {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: var(--bil-gap) var(--bil-gap-lg);
  border-top: var(--bil-border);
  flex-wrap: wrap;
}

.mode-field { flex: 1 1 260px; max-width: 420px; }
.mode-field select { min-height: 44px; }

@keyframes bil-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes bil-dialog-in { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: none; } }

@media (max-width: 700px) {
  .backdrop { padding: 0; align-items: stretch; }
  .dialog { width: 100%; max-height: 100%; border-radius: 0; }
  .dialog-head, .dialog-body, .dialog-foot { padding-left: var(--bil-gap); padding-right: var(--bil-gap); }
  .switcher { padding-left: var(--bil-gap); padding-right: var(--bil-gap); }
  .dialog-error { margin-left: var(--bil-gap); margin-right: var(--bil-gap); }
  .mode-field { flex: 1 1 100%; max-width: none; }
  .dialog-foot .btn { flex: 1 1 auto; }
}
`;

if (!customElements.get("bilresa-action-editor")) {
  customElements.define("bilresa-action-editor", BilresaActionEditor);
}

export { BilresaActionEditor, YamlError };
