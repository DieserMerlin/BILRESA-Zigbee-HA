/**
 * <bilresa-action-editor> — dialog for one action sequence.
 *
 * Three levels, always entered at the first one:
 *   1. Simple    — guided pick lists, no YAML at all. The dialog assembles the
 *                  script sequence itself.
 *   2. Visual    — Home Assistant's own `ha-automation-action`, offered only
 *                  when that element is registered at runtime.
 *   3. YAML      — the fallback, with a runnable example already in the box and
 *                  the list of available variables next to it.
 *
 * Switching levels never drops anything: level 1 can always be written out as
 * YAML. The other direction can fail — a `choose:` block has no place in a pick
 * list — and then the dialog says so instead of quietly rewriting the sequence.
 *
 * The YAML level carries its own tiny reader and writer: the panel ships without
 * a build step and must work offline, so no library can be pulled in. It covers
 * the subset Home Assistant script sequences use — block mappings and sequences,
 * flow collections, quoted and block scalars — and reports the line of a syntax
 * error. The authoritative check stays on the server, which validates the
 * sequence and answers with `invalid_sequence`.
 */

import { sharedStyles } from "./styles.js";
import { ACTION_LABELS, describeError, formatAction, setBinding } from "./api.js";

const SCRIPT_MODES = [
  ["single", "Single — a second press is ignored while the sequence runs"],
  ["restart", "Restart — a second press starts the sequence over"],
  ["queued", "Queued — every press runs, one after another"],
  ["parallel", "Parallel — every press starts its own run"],
];

/**
 * Slot titles come from api.js, so the dialog heading and the row the user
 * clicked to get here can never disagree.
 */
const ACTION_TITLES = ACTION_LABELS;

/** [name, explanation, wheel only] — shown next to the YAML editor. */
const VARIABLES = [
  ["level", "The raw wheel position, 1 to 255.", true],
  ["level_pct", "The same position as a percentage, 0 to 100.", true],
  ["level_254", "The position capped at 254 — ready for a light's brightness.", true],
  ["previous_level", "The position of the previous wheel event, null for the first one.", true],
  ["delta", "How far the wheel moved since then; negative when turned down.", true],
  ["direction", "Either up or down, derived from delta.", true],
  ["mode", "The active channel as a number, starting at 1.", false],
  ["mode_name", "The name you gave that channel.", false],
  ["remote_id", "Internal id of the remote that sent the press.", false],
  ["action", "Which action fired: click, double, triple or wheel.", false],
];

const ICONS = {
  close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  alert: "M13 14h-2V9h2m0 9h-2v-2h2M1 21h22L12 2z",
  info: "M11 9h2V7h-2m1 13c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8m0-18A10 10 0 0 0 2 12a10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2m-1 15h2v-6h-2z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  code: "M14.6 16.6 19.2 12l-4.6-4.6L16 6l6 6-6 6zm-5.2 0L4.8 12l4.6-4.6L8 6l-6 6 6 6z",
  list: "M3 5h2v2H3zm0 6h2v2H3zm0 6h2v2H3zM7 5h14v2H7zm0 6h14v2H7zm0 6h14v2H7z",
  simple:
    "M12 2 9.9 7.9 4 10l5.9 2.1L12 18l2.1-5.9L20 10l-5.9-2.1zM5 15l-.9 2.6L1.5 18.5l2.6.9L5 22l.9-2.6 2.6-.9-2.6-.9z",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z",
  up: "M13 20h-2V8l-5.5 5.5-1.42-1.42L12 4.16l7.92 7.92-1.42 1.42L13 8z",
  down: "M11 4h2v12l5.5-5.5 1.42 1.42L12 19.84 4.08 11.92 5.5 10.5 11 16z",
  trash: "M19 4h-3.5l-1-1h-5l-1 1H5v2h14M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6z",
};

/* ------------------------------------------------------------------- YAML -- */

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
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
      if (Number.isNaN(code)) throw new YamlError("Invalid \\u escape.", ctx.line);
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
  throw new YamlError("A quote was never closed.", ctx.line);
}

function readFlowNode(ctx) {
  skipFlowSpace(ctx);
  const char = ctx.s[ctx.i];
  if (char === undefined) throw new YamlError("The value is incomplete.", ctx.line);
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
    if (ctx.i >= ctx.s.length) throw new YamlError("A closing “]” is missing.", ctx.line);
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
    throw new YamlError("Expected “,” or “]”.", ctx.line);
  }
}

function readFlowMapping(ctx) {
  ctx.i += 1;
  const out = {};
  for (;;) {
    skipFlowSpace(ctx);
    if (ctx.i >= ctx.s.length) throw new YamlError("A closing “}” is missing.", ctx.line);
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
    if (ctx.s[ctx.i] !== ":") throw new YamlError("A “:” is missing inside the braces.", ctx.line);
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
    throw new YamlError("Expected “,” or “}”.", ctx.line);
  }
}

function parseScalarText(text, line) {
  const value = String(text).trim();
  if (!value) return null;
  const first = value[0];
  if (first === "&" || first === "*") {
    throw new YamlError("Anchors and references are not supported here.", line);
  }
  if (first === '"' || first === "'" || first === "[" || first === "{") {
    const ctx = { s: value, i: 0, line };
    const parsed = readFlowNode(ctx);
    skipFlowSpace(ctx);
    if (ctx.i < ctx.s.length) throw new YamlError("Unexpected text after the value.", line);
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
      throw new YamlError("Tabs are not allowed in YAML, please use spaces.", this.pos + 1);
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
      throw new YamlError("Unexpected content — is the indentation right?", this.pos + 1);
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
      if (ind > indent) throw new YamlError("Unexpected indentation.", this.pos + 1);
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
      if (ind > indent) throw new YamlError("Unexpected indentation.", this.pos + 1);
      const content = this.content(line, ind);
      if (/^-(\s|$)/.test(content)) break;
      const split = this.splitKey(content);
      if (!split) throw new YamlError("Expected “key: value”.", this.pos + 1);
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

function isPlain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasElement(name) {
  try {
    return Boolean(customElements.get(name));
  } catch (err) {
    return false;
  }
}

function domainOf(entityId) {
  const text = String(entityId || "");
  const dot = text.indexOf(".");
  return dot > 0 ? text.slice(0, dot) : "";
}

/* ------------------------------------------------------- simple step model -- */

/** Thrown when a guided step is missing something the service call needs. */
class StepError extends Error {
  constructor(message) {
    super(message);
    this.name = "StepError";
  }
}

const INTENTS = [
  { id: "turn_on", label: "Turn on" },
  { id: "turn_off", label: "Turn off" },
  { id: "toggle", label: "Toggle" },
  { id: "brightness", label: "Set brightness" },
  { id: "script", label: "Run a script" },
  { id: "scene", label: "Activate a scene" },
  { id: "button", label: "Press a button" },
  { id: "select", label: "Select an option" },
  { id: "media", label: "Media: play/pause, next, previous, volume" },
  { id: "notify", label: "Send a notification" },
  { id: "delay", label: "Wait a moment" },
  { id: "service", label: "Call any service" },
];

const MEDIA_COMMANDS = [
  ["play_pause", "Play / pause", "media_play_pause"],
  ["play", "Play", "media_play"],
  ["pause", "Pause", "media_pause"],
  ["stop", "Stop", "media_stop"],
  ["next", "Next track", "media_next_track"],
  ["previous", "Previous track", "media_previous_track"],
  ["volume_up", "Volume up", "volume_up"],
  ["volume_down", "Volume down", "volume_down"],
  ["volume_set", "Set volume", "volume_set"],
];

const TARGET_KINDS = [
  ["entity", "Entity"],
  ["device", "Device"],
  ["area", "Area"],
];

/** Keys a guided step carries through untouched instead of refusing the sequence. */
const KEEP_KEYS = ["alias", "enabled", "continue_on_error"];

const BRIGHTNESS_TEMPLATE = "{{ level_254 }}";

function emptyTarget(kind) {
  return { kind: kind || "entity", ids: [""] };
}

function targetToConfig(target) {
  if (!target) return null;
  const ids = (target.ids || []).map((id) => String(id || "").trim()).filter(Boolean);
  if (!ids.length) return null;
  const key = target.kind === "device" ? "device_id" : target.kind === "area" ? "area_id" : "entity_id";
  return { [key]: ids.length === 1 ? ids[0] : ids };
}

function targetFromConfig(config) {
  if (config === null || config === undefined) return emptyTarget();
  if (!isPlain(config)) return null;
  const keys = Object.keys(config).filter((key) => config[key] !== null && config[key] !== undefined);
  if (!keys.length) return emptyTarget();
  if (keys.length > 1) return null;
  const key = keys[0];
  const kind = key === "entity_id" ? "entity" : key === "device_id" ? "device" : key === "area_id" ? "area" : "";
  if (!kind) return null;
  const raw = config[key];
  const ids = Array.isArray(raw) ? raw : [raw];
  if (!ids.every((id) => typeof id === "string")) return null;
  return { kind, ids: ids.length ? ids.slice() : [""] };
}

function firstEntity(target) {
  if (!target || target.kind !== "entity") return "";
  const ids = (target.ids || []).map((id) => String(id || "").trim()).filter(Boolean);
  return ids.length === 1 ? ids[0] : "";
}

function newStep(type, action) {
  const step = { type: type || "turn_on" };
  switch (step.type) {
    case "brightness":
      step.target = emptyTarget();
      step.source = action === "wheel" ? "wheel" : "value";
      step.pct = 60;
      break;
    case "script":
    case "scene":
    case "button":
      step.entity = "";
      break;
    case "select":
      step.entity = "";
      step.op = "option";
      step.option = "";
      break;
    case "media":
      step.target = emptyTarget();
      step.command = "play_pause";
      step.volume = 30;
      break;
    case "notify":
      step.service = "";
      step.title = "";
      step.message = "";
      break;
    case "delay":
      step.seconds = 1;
      break;
    case "service":
      step.service = "";
      step.target = emptyTarget();
      step.data = [];
      break;
    default:
      step.target = emptyTarget();
      break;
  }
  return step;
}

/** Turn a key/value row value into the scalar Home Assistant should receive. */
function parseDataValue(text) {
  const value = String(text ?? "");
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^[-+]?\d+$/.test(trimmed)) {
    const number = parseInt(trimmed, 10);
    if (Number.isSafeInteger(number)) return number;
  }
  if (/^[-+]?(\d+\.\d+|\.\d+)$/.test(trimmed)) return Number(trimmed);
  return value;
}

function formatDataValue(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return String(value ?? "");
}

/**
 * Build the script action for one guided step.
 * `strict` reports missing fields; without it the step is written out as far as
 * it goes, so switching to YAML never throws away half-finished work.
 */
function stepToAction(step, index, strict) {
  const label = `Step ${index + 1}`;
  const fail = (message) => {
    if (strict) throw new StepError(`${label}: ${message}`);
  };

  const target = (what) => {
    const config = targetToConfig(step.target);
    if (!config) fail(what);
    return config;
  };
  const entity = (what) => {
    const value = String(step.entity || "").trim();
    if (!value) fail(what);
    return value;
  };

  let core = null;

  switch (step.type) {
    case "turn_on":
      core = { action: "homeassistant.turn_on", target: target("pick what should be turned on.") };
      break;
    case "turn_off":
      core = { action: "homeassistant.turn_off", target: target("pick what should be turned off.") };
      break;
    case "toggle":
      core = { action: "homeassistant.toggle", target: target("pick what should be toggled.") };
      break;
    case "brightness": {
      const config = target("pick the light to dim.");
      const data =
        step.source === "wheel"
          ? { brightness: BRIGHTNESS_TEMPLATE }
          : { brightness_pct: Math.max(1, Math.min(100, Math.round(Number(step.pct) || 0))) };
      core = { action: "light.turn_on", target: config, data };
      break;
    }
    case "script": {
      const value = entity("pick a script.");
      core = { action: "script.turn_on", target: value ? { entity_id: value } : null };
      break;
    }
    case "scene": {
      const value = entity("pick a scene.");
      core = { action: "scene.turn_on", target: value ? { entity_id: value } : null };
      break;
    }
    case "button": {
      const value = entity("pick a button.");
      core = { action: "button.press", target: value ? { entity_id: value } : null };
      break;
    }
    case "select": {
      const value = entity("pick a selector.");
      const domain = domainOf(value) || "input_select";
      if (step.op === "next" || step.op === "previous") {
        core = {
          action: `${domain}.select_${step.op === "next" ? "next" : "previous"}`,
          target: value ? { entity_id: value } : null,
        };
        break;
      }
      const option = String(step.option || "");
      if (!option) fail("choose the option to select.");
      core = {
        action: `${domain}.select_option`,
        target: value ? { entity_id: value } : null,
        data: { option },
      };
      break;
    }
    case "media": {
      const found = MEDIA_COMMANDS.find(([id]) => id === step.command) || MEDIA_COMMANDS[0];
      const config = target("pick a media player.");
      core = { action: `media_player.${found[2]}`, target: config };
      if (found[0] === "volume_set") {
        const pct = Math.max(0, Math.min(100, Math.round(Number(step.volume) || 0)));
        core.data = { volume_level: Math.round(pct) / 100 };
      }
      break;
    }
    case "notify": {
      const service = String(step.service || "").trim();
      if (!service) fail("pick a notification service.");
      const message = String(step.message || "");
      if (!message) fail("write the message to send.");
      const data = { message };
      if (String(step.title || "").trim()) data.title = String(step.title).trim();
      core = { action: service || "notify.persistent_notification", data };
      break;
    }
    case "delay": {
      const seconds = Math.max(0, Number(step.seconds) || 0);
      core = { delay: { seconds } };
      break;
    }
    case "service": {
      const service = String(step.service || "").trim();
      if (!service) fail("enter the service to call.");
      if (service && !/^[a-z_0-9]+\.[a-z_0-9]+$/.test(service)) {
        fail("the service must look like domain.service, for example light.turn_on.");
      }
      core = { action: service };
      const config = targetToConfig(step.target);
      if (config) core.target = config;
      const data = {};
      for (const row of step.data || []) {
        const key = String(row.key || "").trim();
        if (!key) continue;
        data[key] = parseDataValue(row.value);
      }
      if (Object.keys(data).length) core.data = data;
      break;
    }
    default:
      core = { action: "" };
      break;
  }

  const out = {};
  for (const key of KEEP_KEYS) {
    if (step.keep && step.keep[key] !== undefined) out[key] = step.keep[key];
  }
  for (const [key, value] of Object.entries(core)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Map one script action back onto a guided step, or null when it does not fit. */
function actionToStep(raw) {
  if (!isPlain(raw)) return null;

  const keep = {};
  const core = {};
  for (const [key, value] of Object.entries(raw)) {
    if (KEEP_KEYS.includes(key)) keep[key] = value;
    else if (key !== "metadata") core[key] = value;
  }

  const step = coreToStep(core);
  if (!step) return null;
  if (Object.keys(keep).length) step.keep = keep;
  return step;
}

function coreToStep(core) {
  const keys = Object.keys(core);

  if (keys.length === 1 && keys[0] === "delay") {
    const seconds = delaySeconds(core.delay);
    if (seconds === null) return null;
    return { type: "delay", seconds };
  }

  const service = typeof core.action === "string" ? core.action : typeof core.service === "string" ? core.service : "";
  if (!service || !/^[a-z_0-9]+\.[a-z_0-9]+$/.test(service)) return null;
  const allowed = new Set(["action", "service", "target", "data", "entity_id"]);
  if (!keys.every((key) => allowed.has(key))) return null;

  let target = core.target === undefined ? emptyTarget() : targetFromConfig(core.target);
  if (!target) return null;
  if (core.entity_id !== undefined) {
    if (target.ids.filter(Boolean).length) return null;
    const legacy = targetFromConfig({ entity_id: core.entity_id });
    if (!legacy) return null;
    target = legacy;
  }

  const data = core.data === undefined || core.data === null ? {} : core.data;
  if (!isPlain(data)) return null;
  const dataKeys = Object.keys(data);
  const noData = dataKeys.length === 0;
  const only = (...names) => dataKeys.length === names.length && names.every((name) => dataKeys.includes(name));

  const domain = domainOf(service);
  const name = service.slice(domain.length + 1);
  const single = firstEntity(target);

  if (service === "script.turn_on" && noData && single && domainOf(single) === "script") {
    return { type: "script", entity: single };
  }
  if (domain === "script" && noData && !targetToConfig(target) && !["turn_on", "turn_off", "toggle", "reload"].includes(name)) {
    return { type: "script", entity: service };
  }
  if (service === "scene.turn_on" && noData && single && domainOf(single) === "scene") {
    return { type: "scene", entity: single };
  }
  if (service === "button.press" && noData && single && domainOf(single) === "button") {
    return { type: "button", entity: single };
  }
  if ((domain === "input_select" || domain === "select") && single) {
    if (name === "select_option" && only("option") && typeof data.option === "string") {
      return { type: "select", entity: single, op: "option", option: data.option };
    }
    if (name === "select_next" && noData) return { type: "select", entity: single, op: "next", option: "" };
    if (name === "select_previous" && noData) {
      return { type: "select", entity: single, op: "previous", option: "" };
    }
  }
  if (domain === "media_player" && targetToConfig(target)) {
    const found = MEDIA_COMMANDS.find(([, , call]) => call === name);
    if (found && found[0] === "volume_set" && only("volume_level") && typeof data.volume_level === "number") {
      return {
        type: "media",
        target,
        command: "volume_set",
        volume: Math.max(0, Math.min(100, Math.round(data.volume_level * 100))),
      };
    }
    if (found && found[0] !== "volume_set" && noData) {
      return { type: "media", target, command: found[0], volume: 30 };
    }
  }
  if (domain === "notify" && !targetToConfig(target) && typeof data.message === "string") {
    if (only("message") || only("message", "title")) {
      return {
        type: "notify",
        service,
        message: data.message,
        title: typeof data.title === "string" ? data.title : "",
      };
    }
  }
  if (service === "light.turn_on" && targetToConfig(target)) {
    if (only("brightness_pct") && typeof data.brightness_pct === "number") {
      return {
        type: "brightness",
        target,
        source: "value",
        pct: Math.max(1, Math.min(100, Math.round(data.brightness_pct))),
      };
    }
    if (only("brightness") && typeof data.brightness === "string" && data.brightness.includes("level_254")) {
      return { type: "brightness", target, source: "wheel", pct: 60 };
    }
  }
  if (noData && targetToConfig(target)) {
    if (name === "turn_on") return { type: "turn_on", target };
    if (name === "turn_off") return { type: "turn_off", target };
    if (name === "toggle") return { type: "toggle", target };
  }

  // Everything else that is still a plain service call: the generic step.
  const rows = [];
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object") return null;
    rows.push({ key, value: formatDataValue(value) });
  }
  return { type: "service", service, target, data: rows };
}

function delaySeconds(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (!isPlain(value)) return null;
  const allowed = ["hours", "minutes", "seconds", "milliseconds"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return null;
  let total = 0;
  for (const key of allowed) {
    const part = value[key];
    if (part === undefined || part === null) continue;
    if (typeof part !== "number" || !Number.isFinite(part)) return null;
    total +=
      key === "hours" ? part * 3600 : key === "minutes" ? part * 60 : key === "seconds" ? part : part / 1000;
  }
  return Math.round(total * 1000) / 1000;
}

function stepsFromSequence(sequence) {
  const list = Array.isArray(sequence) ? sequence : [];
  const steps = [];
  for (const raw of list) {
    const step = actionToStep(raw);
    if (!step) return null;
    steps.push(step);
  }
  return steps;
}

/* ---------------------------------------------------------------- example -- */

function exampleLines(action) {
  if (action === "wheel") {
    return [
      "- action: light.turn_on",
      "  target:",
      "    entity_id: light.kitchen",
      "  data:",
      "    # level_254 is the wheel position, ready for a light.",
      "    brightness: \"{{ level_254 }}\"",
    ];
  }
  return ["- action: light.turn_on", "  target:", "    entity_id: light.kitchen"];
}

function exampleText(action) {
  return `${exampleLines(action).join("\n")}\n`;
}

function commentedExample(action) {
  const head = [
    "# Nothing is assigned yet. Below is a working example for this slot —",
    "# delete the “#” in front of the lines, or press “Insert example”.",
  ];
  const body = exampleLines(action).map((line) => `# ${line}`);
  return `${head.concat(body).join("\n")}\n`;
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
    this._steps = [];
    this._scriptMode = "single";
    this._mode = "simple";
    this._yamlText = "";
    this._textarea = null;
    this._visualEl = null;
    this._visualBroken = false;
    this._note = "";
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
    this._yamlText = sequence.length ? dumpYaml(sequence) : commentedExample(this._action);
    this._scriptMode =
      typeof binding.script_mode === "string" && SCRIPT_MODES.some(([id]) => id === binding.script_mode)
        ? binding.script_mode
        : this._action === "wheel"
          ? "restart"
          : "single";

    const steps = stepsFromSequence(sequence);
    if (steps) {
      this._steps = steps;
      this._mode = "simple";
      this._note = "";
      return;
    }
    // Never silently rewrite something the pick lists cannot express.
    this._steps = [];
    this._mode = this._visualAvailable() ? "visual" : "yaml";
    this._note =
      "This action is too complex for the simple editor, so it opened in the " +
      (this._mode === "visual" ? "visual editor" : "YAML editor") +
      ". Everything it does is kept as it is.";
  }

  _visualAvailable() {
    if (this._visualBroken) return false;
    return hasElement("ha-automation-action");
  }

  /* ------------------------------------------------------------- render -- */

  _render() {
    const root = this.shadowRoot;
    root.textContent = "";

    const style = document.createElement("style");
    style.textContent = `${sharedStyles}\n${DIALOG_STYLES}`;
    root.append(style);

    this._error = h("div", { class: "dialog-error", role: "alert", hidden: true });
    this._noteEl = h("div", { class: "dialog-note", hidden: true });
    if (this._note) {
      this._noteEl.append(icon("info"), h("span", { text: this._note }));
      this._noteEl.hidden = false;
    }
    this._bodyHost = h("div", { class: "dialog-body" });

    const label = ACTION_TITLES[this._action] || formatAction(this._action) || "Action";
    const heading = h("h2", {
      id: `${this._uid}-title`,
      class: "dialog-title",
      text: `What should “${label}” do?`,
    });
    const subtitle = h("p", { class: "dialog-sub muted small", text: this._context });

    const closeBtn = h(
      "button",
      {
        type: "button",
        class: "icon-btn",
        "aria-label": "Close dialog",
        title: "Close",
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
      "aria-label": `Assign actions to ${label}`,
      "aria-labelledby": `${this._uid}-title`,
    });

    dialog.append(
      h("span", { class: "sentinel", tabindex: "0", "aria-hidden": "true", onfocus: () => this._wrapFocus("end") }),
      header,
      this._buildSwitcher(),
      this._noteEl,
      this._bodyHost,
      this._error,
      this._buildFooter(),
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
    const group = h("div", { class: "switcher", role: "group", "aria-label": "Editor level" });
    const make = (mode, text, iconName, hint) =>
      h(
        "button",
        {
          type: "button",
          class: `switch-btn${this._mode === mode ? " is-active" : ""}`,
          "aria-pressed": this._mode === mode ? "true" : "false",
          title: hint,
          onclick: () => this._setMode(mode),
        },
        icon(iconName),
        h("span", { text })
      );
    group.append(make("simple", "Simple", "simple", "Guided pick lists, no YAML"));
    if (this._visualAvailable()) {
      group.append(make("visual", "Visual", "list", "Home Assistant's own action editor"));
    }
    group.append(make("yaml", "YAML", "code", "Write the sequence by hand"));
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
      SCRIPT_MODES.map(([id, text]) => h("option", { value: id, selected: id === this._scriptMode }, text))
    );

    this._saveBtn = h(
      "button",
      { type: "button", class: "btn primary", onclick: () => this._save() },
      icon("check"),
      h("span", { text: "Save" })
    );

    return h(
      "footer",
      { class: "dialog-foot" },
      h(
        "div",
        { class: "field mode-field" },
        h("label", { for: `${this._uid}-script-mode`, text: "When pressed again" }),
        select
      ),
      h("div", { class: "spacer" }),
      h(
        "button",
        { type: "button", class: "btn ghost", onclick: () => this._requestClose() },
        h("span", { text: "Cancel" })
      ),
      this._saveBtn
    );
  }

  _renderBody() {
    const host = this._bodyHost;
    host.textContent = "";
    this._visualEl = null;
    this._textarea = null;
    this._stepsHost = null;
    if (this._visualCheck) {
      clearTimeout(this._visualCheck);
      this._visualCheck = null;
    }

    if (this._mode === "simple") {
      host.append(this._buildSimpleView());
      return;
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
          this._yamlText = this._yamlFor(this._sequence);
          this._render();
          this._showError("Home Assistant's visual editor could not be loaded — here is the YAML view instead.");
        }, 1200);
        return;
      }
      this._mode = "yaml";
    }

    host.append(this._buildYamlView());
  }

  /* -------------------------------------------------------- simple level -- */

  _buildSimpleView() {
    const wrap = h("div", { class: "simple" });

    if (this._action === "wheel") {
      wrap.append(
        h("p", {
          class: "simple-lead muted small",
          text:
            "The wheel reports an absolute position from 1 to 255 on every step. “Set brightness” can take that " +
            "position directly.",
        })
      );
    }

    this._stepsHost = h("div", { class: "steps" });
    wrap.append(this._stepsHost);

    const addBtn = h(
      "button",
      {
        type: "button",
        class: "btn small add-step",
        onclick: () => {
          this._steps.push(newStep("turn_on", this._action));
          this._markDirty();
          this._renderStepList(this._steps.length - 1);
        },
      },
      icon("plus"),
      h("span", { text: "Add step" })
    );
    wrap.append(h("div", { class: "row wrap step-add" }, addBtn));

    this._renderStepList();
    return wrap;
  }

  _renderStepList(focusIndex) {
    const host = this._stepsHost;
    if (!host) return;
    host.textContent = "";
    if (!this._steps.length) {
      host.append(
        h(
          "div",
          { class: "simple-empty" },
          h("strong", { text: "Nothing happens yet." }),
          h("p", {
            class: "muted small",
            text: "Add a step and pick what this press should do. You can chain several steps.",
          })
        )
      );
      return;
    }
    this._steps.forEach((step, index) => host.append(this._buildStepCard(step, index)));
    if (focusIndex !== undefined) {
      const card = host.children[focusIndex];
      const select = card ? card.querySelector("select.step-type") : null;
      if (select) select.focus();
    }
  }

  _buildStepCard(step, index) {
    const card = h("section", { class: "step card outline" });

    const typeSelect = h(
      "select",
      {
        class: "step-type",
        "aria-label": `What step ${index + 1} does`,
        onchange: (event) => {
          const kept = step.keep;
          const replacement = newStep(event.target.value, this._action);
          if (kept) replacement.keep = kept;
          // Carry the target over: switching between turn on/off/toggle should
          // not make the user pick the same lamp again.
          if (step.target && replacement.target) replacement.target = clone(step.target);
          else if (step.entity && replacement.target) replacement.target = { kind: "entity", ids: [step.entity] };
          else if (replacement.entity !== undefined) {
            const single = firstEntity(step.target) || step.entity || "";
            const wanted = ENTITY_DOMAINS[replacement.type] || [];
            replacement.entity = wanted.includes(domainOf(single)) ? single : "";
          }
          this._steps[index] = replacement;
          this._markDirty();
          this._buildStepBody(this._steps[index], body, index);
        },
      },
      INTENTS.map((intent) =>
        h("option", { value: intent.id, selected: intent.id === step.type }, intent.label)
      )
    );

    const tool = (name, title, disabled, handler) =>
      h(
        "button",
        {
          type: "button",
          class: "icon-btn small-icon",
          "aria-label": `${title} step ${index + 1}`,
          title,
          disabled,
          onclick: handler,
        },
        icon(name)
      );

    const tools = h(
      "div",
      { class: "step-tools" },
      tool("up", "Move up", index === 0, () => this._moveStep(index, -1)),
      tool("down", "Move down", index === this._steps.length - 1, () => this._moveStep(index, 1)),
      tool("trash", "Delete", false, () => {
        this._steps.splice(index, 1);
        this._markDirty();
        this._renderStepList();
      })
    );

    const head = h(
      "header",
      { class: "step-head" },
      h("span", { class: "step-num", "aria-hidden": "true", text: String(index + 1) }),
      typeSelect,
      tools
    );

    const body = h("div", { class: "step-body" });
    card.append(head, body);
    this._buildStepBody(step, body, index);
    return card;
  }

  _buildStepBody(step, host, index) {
    host.textContent = "";
    const number = index + 1;

    switch (step.type) {
      case "turn_on":
      case "turn_off":
      case "toggle":
        host.append(this._targetField(step, number, null, "What should it act on?"));
        break;

      case "brightness": {
        host.append(this._targetField(step, number, ["light"], "Which light?"));
        const valueHost = h("div", { class: "sub-field" });
        const offerWheel = this._action === "wheel" || step.source === "wheel";
        const sourceSelect = h(
          "select",
          {
            "aria-label": `Brightness source for step ${number}`,
            onchange: (event) => {
              step.source = event.target.value;
              this._markDirty();
              paint();
            },
          },
          h("option", { value: "value", selected: step.source !== "wheel" }, "Use a fixed brightness"),
          offerWheel
            ? h("option", { value: "wheel", selected: step.source === "wheel" }, "Use the wheel value")
            : null
        );
        const paint = () => {
          valueHost.textContent = "";
          if (step.source === "wheel") {
            valueHost.append(
              h("p", {
                class: "muted small",
                text: `The wheel position is passed straight to the light as brightness: "${BRIGHTNESS_TEMPLATE}".`,
              })
            );
            return;
          }
          valueHost.append(
            this._rangeRow(step.pct, 1, 100, "%", `Brightness for step ${number}`, (value) => {
              step.pct = value;
              this._markDirty();
            })
          );
        };
        paint();
        host.append(this._field("Brightness", sourceSelect), valueHost);
        break;
      }

      case "script":
        host.append(
          this._field(
            "Script",
            this._entityField(step.entity, ["script"], `Script for step ${number}`, (value) => {
              step.entity = value;
              this._markDirty();
            })
          ),
          h("p", {
            class: "muted small",
            text: "The script is started and runs on its own; the remote does not wait for it.",
          })
        );
        break;

      case "scene":
        host.append(
          this._field(
            "Scene",
            this._entityField(step.entity, ["scene"], `Scene for step ${number}`, (value) => {
              step.entity = value;
              this._markDirty();
            })
          )
        );
        break;

      case "button":
        host.append(
          this._field(
            "Button",
            this._entityField(step.entity, ["button", "input_button"], `Button for step ${number}`, (value) => {
              step.entity = value;
              this._markDirty();
            })
          )
        );
        break;

      case "select": {
        const optionHost = h("div", { class: "sub-field" });
        const paintOption = () => {
          optionHost.textContent = "";
          if (step.op !== "option") return;
          optionHost.append(this._optionField(step, number));
        };
        const opSelect = h(
          "select",
          {
            "aria-label": `What to select in step ${number}`,
            onchange: (event) => {
              step.op = event.target.value;
              this._markDirty();
              paintOption();
            },
          },
          h("option", { value: "option", selected: step.op === "option" }, "A specific option"),
          h("option", { value: "next", selected: step.op === "next" }, "The next option"),
          h("option", { value: "previous", selected: step.op === "previous" }, "The previous option")
        );
        host.append(
          this._field(
            "Selector",
            this._entityField(step.entity, ["input_select", "select"], `Selector for step ${number}`, (value) => {
              step.entity = value;
              this._markDirty();
              paintOption();
            })
          ),
          this._field("Choose", opSelect),
          optionHost
        );
        paintOption();
        break;
      }

      case "media": {
        const extraHost = h("div", { class: "sub-field" });
        const paintExtra = () => {
          extraHost.textContent = "";
          if (step.command !== "volume_set") return;
          extraHost.append(
            this._rangeRow(step.volume, 0, 100, "%", `Volume for step ${number}`, (value) => {
              step.volume = value;
              this._markDirty();
            })
          );
        };
        const commandSelect = h(
          "select",
          {
            "aria-label": `Media command for step ${number}`,
            onchange: (event) => {
              step.command = event.target.value;
              this._markDirty();
              paintExtra();
            },
          },
          MEDIA_COMMANDS.map(([id, text]) => h("option", { value: id, selected: id === step.command }, text))
        );
        host.append(
          this._targetField(step, number, ["media_player"], "Which player?"),
          this._field("Command", commandSelect),
          extraHost
        );
        paintExtra();
        break;
      }

      case "notify": {
        const services = this._notifyServices();
        let serviceControl;
        if (services.length) {
          if (!step.service) {
            step.service = services.includes("notify.persistent_notification")
              ? "notify.persistent_notification"
              : services[0];
          }
          serviceControl = h(
            "select",
            {
              "aria-label": `Notification service for step ${number}`,
              onchange: (event) => {
                step.service = event.target.value;
                this._markDirty();
              },
            },
            services.map((id) => h("option", { value: id, selected: id === step.service }, id.slice(7))),
            services.includes(step.service) || !step.service
              ? null
              : h("option", { value: step.service, selected: true }, step.service.slice(7))
          );
        } else {
          serviceControl = h("input", {
            type: "text",
            class: "mono",
            value: step.service || "notify.persistent_notification",
            "aria-label": `Notification service for step ${number}`,
            oninput: (event) => {
              step.service = event.target.value;
              this._markDirty();
            },
          });
        }

        const title = h("input", {
          type: "text",
          value: step.title || "",
          placeholder: "optional",
          "aria-label": `Notification title for step ${number}`,
          oninput: (event) => {
            step.title = event.target.value;
            this._markDirty();
          },
        });
        const message = h("textarea", {
          rows: "2",
          "aria-label": `Notification text for step ${number}`,
          placeholder: "Kitchen light switched on",
          oninput: (event) => {
            step.message = event.target.value;
            this._markDirty();
          },
        });
        message.value = step.message || "";

        host.append(
          this._field("Service", serviceControl),
          h("div", { class: "grid2" }, this._field("Title", title), this._field("Message", message))
        );
        break;
      }

      case "delay": {
        const input = h("input", {
          type: "number",
          min: "0",
          step: "0.5",
          value: String(step.seconds ?? 1),
          "aria-label": `Seconds to wait in step ${number}`,
          oninput: (event) => {
            step.seconds = Number(event.target.value) || 0;
            this._markDirty();
          },
        });
        host.append(
          this._field("Seconds", input),
          h("p", { class: "muted small", text: "Pauses before the next step runs." })
        );
        break;
      }

      case "service": {
        const listId = `${this._uid}-svc-${index}`;
        const services = this._serviceOptions();
        const input = h("input", {
          type: "text",
          class: "mono",
          value: step.service || "",
          list: services.length ? listId : undefined,
          placeholder: "light.turn_on",
          "aria-label": `Service for step ${number}`,
          oninput: (event) => {
            step.service = event.target.value.trim();
            this._markDirty();
          },
        });
        const datalist = services.length
          ? h("datalist", { id: listId }, services.map((id) => h("option", { value: id })))
          : null;

        host.append(
          this._field("Service", input, datalist),
          this._targetField(step, number, null, "Target (optional)"),
          this._dataRows(step, number)
        );
        break;
      }

      default:
        host.append(h("p", { class: "muted small", text: "Pick what this step should do." }));
        break;
    }
  }

  _field(labelText, control, extra) {
    const id = `${this._uid}-f-${++fieldCounter}`;
    // The fallback picker is a wrapper: label the input inside it, not the box.
    const labelled =
      control && control.classList && control.classList.contains("combo")
        ? control.querySelector("input")
        : control;
    if (labelled && labelled.tagName && !labelled.id) labelled.id = id;
    return h(
      "div",
      { class: "field" },
      h("label", { for: labelled && labelled.id ? labelled.id : undefined, text: labelText }),
      control,
      extra || null
    );
  }

  _rangeRow(value, min, max, unit, label, onChange) {
    const current = Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
    const out = h("span", { class: "range-value mono", text: `${current}${unit}` });
    const input = h("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: "1",
      "aria-label": label,
      oninput: (event) => {
        const next = Number(event.target.value);
        out.textContent = `${next}${unit}`;
        onChange(next);
      },
    });
    input.value = String(current);
    return h("div", { class: "range-row" }, input, out);
  }

  _dataRows(step, number) {
    const wrap = h("div", { class: "field" });
    wrap.append(h("label", { text: "Extra data" }));
    const rowsHost = h("div", { class: "kv" });

    const paint = () => {
      rowsHost.textContent = "";
      (step.data || []).forEach((row, i) => {
        const key = h("input", {
          type: "text",
          class: "mono",
          value: row.key || "",
          placeholder: "brightness_pct",
          "aria-label": `Data key ${i + 1} of step ${number}`,
          oninput: (event) => {
            row.key = event.target.value;
            this._markDirty();
          },
        });
        const value = h("input", {
          type: "text",
          class: "mono",
          value: row.value || "",
          placeholder: "60",
          "aria-label": `Data value ${i + 1} of step ${number}`,
          oninput: (event) => {
            row.value = event.target.value;
            this._markDirty();
          },
        });
        const remove = h(
          "button",
          {
            type: "button",
            class: "icon-btn small-icon",
            "aria-label": `Remove data row ${i + 1} of step ${number}`,
            title: "Remove",
            onclick: () => {
              step.data.splice(i, 1);
              this._markDirty();
              paint();
            },
          },
          icon("trash")
        );
        rowsHost.append(h("div", { class: "kv-row" }, key, value, remove));
      });
      if (!step.data || !step.data.length) {
        rowsHost.append(h("p", { class: "muted small", text: "No extra data — most services do not need any." }));
      }
    };

    const add = h(
      "button",
      {
        type: "button",
        class: "btn small",
        onclick: () => {
          if (!Array.isArray(step.data)) step.data = [];
          step.data.push({ key: "", value: "" });
          this._markDirty();
          paint();
        },
      },
      icon("plus"),
      h("span", { text: "Add value" })
    );

    paint();
    wrap.append(
      rowsHost,
      h("p", {
        class: "hint",
        text: "true, false, numbers and null are sent as such, everything else as text.",
      }),
      h("div", { class: "row wrap" }, add)
    );
    return wrap;
  }

  /* ------------------------------------------------------------ pickers -- */

  _targetField(step, number, domains, labelText) {
    if (!step.target) step.target = emptyTarget();
    const wrap = h("div", { class: "field" });
    wrap.append(h("label", { text: labelText || "Target" }));

    const listHost = h("div", { class: "target-list" });
    const kinds = h("div", { class: "seg", role: "group", "aria-label": `Target type of step ${number}` });

    const paintList = () => {
      listHost.textContent = "";
      const ids = step.target.ids && step.target.ids.length ? step.target.ids : [""];
      step.target.ids = ids;
      ids.forEach((value, i) => {
        const row = h("div", { class: "target-row" });
        const kind = TARGET_KINDS.find(([id]) => id === step.target.kind) || TARGET_KINDS[0];
        const label = `${kind[1]} ${i + 1} of step ${number}`;
        const control =
          step.target.kind === "entity"
            ? this._entityField(value, domains, label, (next) => {
                step.target.ids[i] = next;
                this._markDirty();
              })
            : this._registryField(step.target.kind, value, label, (next) => {
                step.target.ids[i] = next;
                this._markDirty();
              });
        row.append(control);
        if (ids.length > 1) {
          row.append(
            h(
              "button",
              {
                type: "button",
                class: "icon-btn small-icon",
                "aria-label": `Remove ${label}`,
                title: "Remove",
                onclick: () => {
                  step.target.ids.splice(i, 1);
                  this._markDirty();
                  paintList();
                },
              },
              icon("trash")
            )
          );
        }
        listHost.append(row);
      });
      listHost.append(
        h(
          "button",
          {
            type: "button",
            class: "link add-target",
            onclick: () => {
              step.target.ids.push("");
              paintList();
            },
          },
          "+ Add another"
        )
      );
    };

    for (const [id, text] of TARGET_KINDS) {
      kinds.append(
        h(
          "button",
          {
            type: "button",
            class: `seg-btn${step.target.kind === id ? " is-active" : ""}`,
            "aria-pressed": step.target.kind === id ? "true" : "false",
            onclick: () => {
              if (step.target.kind === id) return;
              step.target = { kind: id, ids: [""] };
              this._markDirty();
              for (const node of kinds.children) {
                const active = node.dataset.kind === id;
                node.classList.toggle("is-active", active);
                node.setAttribute("aria-pressed", active ? "true" : "false");
              }
              paintList();
            },
          },
          text
        )
      );
      kinds.lastChild.dataset.kind = id;
    }

    paintList();
    wrap.append(kinds, listHost);
    return wrap;
  }

  _optionField(step, number) {
    const state = this._hass && this._hass.states ? this._hass.states[step.entity] : null;
    const options = state && Array.isArray(state.attributes && state.attributes.options)
      ? state.attributes.options
      : [];
    if (options.length) {
      const select = h(
        "select",
        {
          "aria-label": `Option for step ${number}`,
          onchange: (event) => {
            step.option = event.target.value;
            this._markDirty();
          },
        },
        options.map((option) => h("option", { value: option, selected: option === step.option }, option)),
        options.includes(step.option) || !step.option
          ? null
          : h("option", { value: step.option, selected: true }, step.option)
      );
      return this._field("Option", select);
    }
    const input = h("input", {
      type: "text",
      value: step.option || "",
      placeholder: "Name of the option",
      "aria-label": `Option for step ${number}`,
      oninput: (event) => {
        step.option = event.target.value;
        this._markDirty();
      },
    });
    return this._field("Option", input);
  }

  /** HA's own entity picker when it exists, otherwise the built-in combo box. */
  _entityField(value, domains, label, onChange) {
    if (hasElement("ha-entity-picker")) {
      try {
        const element = document.createElement("ha-entity-picker");
        element.hass = this._hass;
        element.allowCustomEntity = true;
        element.label = label;
        if (domains && domains.length) element.includeDomains = domains.slice();
        element.value = value || "";
        element.addEventListener("value-changed", (event) => {
          event.stopPropagation();
          const next = event.detail && event.detail.value ? String(event.detail.value) : "";
          onChange(next);
        });
        return element;
      } catch (err) {
        // Fall through to the built-in picker.
      }
    }
    return this._combo({
      value,
      label,
      placeholder: "Search by name…",
      options: this._entityOptions(domains),
      onChange,
    });
  }

  _registryField(kind, value, label, onChange) {
    const tag = kind === "device" ? "ha-device-picker" : "ha-area-picker";
    if (hasElement(tag)) {
      try {
        const element = document.createElement(tag);
        element.hass = this._hass;
        element.label = label;
        element.value = value || "";
        element.addEventListener("value-changed", (event) => {
          event.stopPropagation();
          const next = event.detail && event.detail.value ? String(event.detail.value) : "";
          onChange(next);
        });
        return element;
      } catch (err) {
        // Fall through to the built-in picker.
      }
    }
    return this._combo({
      value,
      label,
      placeholder: kind === "device" ? "Search devices…" : "Search areas…",
      options: kind === "device" ? this._deviceOptions() : this._areaOptions(),
      onChange,
    });
  }

  _entityOptions(domains) {
    const states = (this._hass && this._hass.states) || {};
    const wanted = domains && domains.length ? new Set(domains) : null;
    const out = [];
    for (const [id, state] of Object.entries(states)) {
      if (wanted && !wanted.has(domainOf(id))) continue;
      const name = (state && state.attributes && state.attributes.friendly_name) || id;
      out.push({ value: id, label: String(name), hint: id });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  _deviceOptions() {
    const devices = (this._hass && this._hass.devices) || {};
    const out = [];
    for (const [id, device] of Object.entries(devices)) {
      const name = (device && (device.name_by_user || device.name)) || id;
      out.push({ value: id, label: String(name), hint: "" });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  _areaOptions() {
    const areas = (this._hass && this._hass.areas) || {};
    const out = [];
    for (const [id, area] of Object.entries(areas)) {
      out.push({ value: id, label: String((area && area.name) || id), hint: "" });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  _notifyServices() {
    const services = (this._hass && this._hass.services && this._hass.services.notify) || {};
    return Object.keys(services)
      .map((name) => `notify.${name}`)
      .sort();
  }

  _serviceOptions() {
    const services = (this._hass && this._hass.services) || {};
    const out = [];
    for (const [domain, entries] of Object.entries(services)) {
      for (const name of Object.keys(entries || {})) out.push(`${domain}.${name}`);
    }
    out.sort();
    return out;
  }

  /**
   * Searchable picker over friendly names, used whenever Home Assistant's own
   * pickers are not registered in this frontend build.
   */
  _combo({ value, label, placeholder, options, onChange }) {
    const wrap = h("div", { class: "combo" });
    const input = h("input", {
      type: "text",
      class: "combo-input",
      role: "combobox",
      "aria-expanded": "false",
      "aria-autocomplete": "list",
      "aria-label": label || "Search",
      placeholder: placeholder || "Search…",
      autocomplete: "off",
      spellcheck: "false",
    });
    const list = h("div", { class: "combo-list", role: "listbox", "aria-label": label || "Results", hidden: true });
    const hint = h("p", { class: "combo-hint mono small muted" });

    let current = String(value || "");
    let query = "";
    let active = -1;
    let items = [];

    const labelFor = (id) => {
      const found = options.find((option) => option.value === id);
      return found ? found.label : id;
    };
    const showValue = () => {
      input.value = current ? labelFor(current) : "";
      hint.textContent = current && current !== labelFor(current) ? current : "";
    };
    const close = () => {
      list.hidden = true;
      list.textContent = "";
      input.setAttribute("aria-expanded", "false");
      active = -1;
    };
    const pick = (id) => {
      current = id;
      showValue();
      close();
      onChange(id);
    };
    const refresh = () => {
      const needle = query.trim().toLowerCase();
      items = options
        .filter(
          (option) =>
            !needle ||
            option.label.toLowerCase().includes(needle) ||
            option.value.toLowerCase().includes(needle)
        )
        .slice(0, 60);
      list.textContent = "";
      if (!items.length) {
        list.append(
          h("p", {
            class: "combo-empty muted small",
            text: options.length ? "Nothing matches." : "Nothing to choose from here.",
          })
        );
      }
      items.forEach((option, i) => {
        list.append(
          h(
            "button",
            {
              type: "button",
              class: `combo-opt${i === active ? " is-active" : ""}`,
              role: "option",
              "aria-selected": option.value === current ? "true" : "false",
              // Keep focus in the input so blur does not fire before the click.
              onmousedown: (event) => event.preventDefault(),
              onclick: () => pick(option.value),
            },
            h("span", { class: "combo-name", text: option.label }),
            option.hint ? h("span", { class: "combo-id mono small muted", text: option.hint }) : null
          )
        );
      });
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      if (active >= 0 && list.children[active] && list.children[active].scrollIntoView) {
        list.children[active].scrollIntoView({ block: "nearest" });
      }
    };

    input.addEventListener("focus", () => {
      query = "";
      active = -1;
      refresh();
    });
    input.addEventListener("input", () => {
      query = input.value;
      active = -1;
      refresh();
    });
    input.addEventListener("blur", () => {
      const typed = input.value.trim();
      if (!typed) {
        if (current) {
          current = "";
          onChange("");
        }
      } else if (!options.length && typed !== current) {
        // No registry to pick from: accept the raw id the user typed.
        current = typed;
        onChange(typed);
      }
      showValue();
      close();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (list.hidden) {
          refresh();
          return;
        }
        if (!items.length) return;
        active = event.key === "ArrowDown" ? Math.min(items.length - 1, active + 1) : Math.max(0, active - 1);
        refresh();
        return;
      }
      if (event.key === "Enter") {
        if (!list.hidden && active >= 0 && items[active]) {
          event.preventDefault();
          pick(items[active].value);
        }
        return;
      }
      if (event.key === "Escape" && !list.hidden) {
        // The dialog closes on Escape — not while a list is open.
        event.preventDefault();
        event.stopPropagation();
        showValue();
        close();
      }
    });

    showValue();
    wrap.append(input, list, hint);
    return wrap;
  }

  _moveStep(index, delta) {
    const next = index + delta;
    if (next < 0 || next >= this._steps.length) return;
    const [step] = this._steps.splice(index, 1);
    this._steps.splice(next, 0, step);
    this._markDirty();
    this._renderStepList(next);
  }

  /* -------------------------------------------------------- visual level -- */

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
        this._markDirty();
      });
      return element;
    } catch (err) {
      this._visualBroken = true;
      return null;
    }
  }

  /* ---------------------------------------------------------- yaml level -- */

  _yamlFor(sequence) {
    const list = Array.isArray(sequence) ? sequence : [];
    return list.length ? dumpYaml(list) : commentedExample(this._action);
  }

  _buildYamlView() {
    const wrap = h("div", { class: "yaml-wrap" });

    this._textarea = h("textarea", {
      class: "yaml-area mono",
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      rows: "16",
      "aria-label": "Action sequence as YAML",
      placeholder: "- action: light.turn_on\n  target:\n    entity_id: light.kitchen",
      oninput: (event) => {
        this._yamlText = event.target.value;
        this._markDirty();
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

    const insert = h(
      "button",
      {
        type: "button",
        class: "btn small",
        onclick: () => this._insertExample(),
      },
      icon("plus"),
      h("span", { text: "Insert example" })
    );

    wrap.append(
      h(
        "div",
        { class: "row wrap yaml-tools" },
        insert,
        h("span", {
          class: "muted small",
          text: "A list of steps, exactly as in the automation editor. Home Assistant checks it when you save.",
        })
      ),
      this._textarea,
      this._buildVariables()
    );
    return wrap;
  }

  _buildVariables() {
    const details = h("details", { class: "vars" });
    details.append(h("summary", { text: "Variables you can use in templates" }));
    const list = h("dl", { class: "vars-list" });
    for (const [name, text, wheelOnly] of VARIABLES) {
      list.append(
        h("dt", { class: "mono" }, name, wheelOnly ? h("span", { class: "vars-tag", text: "wheel only" }) : null),
        h("dd", { text })
      );
    }
    details.append(
      list,
      h("p", {
        class: "muted small",
        text: "Use them like {{ level_254 }} inside a value, the same way as in any Home Assistant template.",
      })
    );
    return details;
  }

  _insertExample() {
    if (!this._textarea) return;
    const example = exampleText(this._action);
    let existing = [];
    try {
      existing = this._normalise(parseYaml(this._textarea.value));
    } catch (err) {
      existing = [];
    }
    const current = this._textarea.value.replace(/\s+$/, "");
    // Only append when there is a real sequence — comments alone get replaced.
    this._textarea.value = existing.length ? `${current}\n${example}` : example;
    this._yamlText = this._textarea.value;
    this._markDirty();
    this._textarea.focus();
    const end = this._textarea.value.length;
    this._textarea.setSelectionRange(end, end);
  }

  /* ---------------------------------------------------------- behaviour -- */

  _markDirty() {
    this._dirty = true;
    this._confirmClose = false;
    this._confirmEmpty = false;
    this._clearError();
  }

  _setMode(mode) {
    if (mode === this._mode) return;

    let sequence;
    try {
      sequence = this._collectSequence(false);
    } catch (err) {
      this._showError(err instanceof YamlError ? err.message : describeError(err));
      return;
    }

    if (mode === "simple") {
      const steps = stepsFromSequence(sequence);
      if (!steps) {
        this._showError(
          "This action is too complex for the simple editor. Keep editing it in the " +
            (this._visualAvailable() ? "visual editor or in YAML." : "YAML editor.")
        );
        return;
      }
      this._steps = steps;
    }

    this._sequence = sequence;
    this._yamlText = this._yamlFor(sequence);
    this._note = "";
    this._mode = mode;
    this._render();
    requestAnimationFrame(() => this._focusFirst());
  }

  _normalise(value) {
    if (value === null || value === undefined) return [];
    const list = Array.isArray(value) ? value : [value];
    list.forEach((step, index) => {
      if (!isPlain(step)) {
        throw new YamlError(`Step ${index + 1} is not an action (expected “key: value”).`);
      }
    });
    return list;
  }

  /** Current content as a script sequence. `strict` also checks guided steps. */
  _collectSequence(strict) {
    if (this._mode === "simple") {
      return this._steps.map((step, index) => stepToAction(step, index, strict));
    }
    if (this._mode === "yaml") {
      const text = this._textarea ? this._textarea.value : this._yamlText;
      this._yamlText = text;
      return this._normalise(parseYaml(text));
    }
    return this._normalise(this._sequence);
  }

  async _save() {
    if (this._saving) return;
    let sequence;
    try {
      sequence = this._collectSequence(true);
    } catch (err) {
      if (err instanceof YamlError || err instanceof StepError) this._showError(err.message);
      else this._showError(describeError(err));
      return;
    }

    if (!sequence.length && !this._confirmEmpty) {
      this._confirmEmpty = true;
      this._showError("The sequence is empty — saving clears this slot. Press Save again if that is what you want.");
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
      // The dialog stays open and keeps the input: the user must not retype it.
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
    this._saveBtn.append(icon("check"), h("span", { text: saving ? "Saving …" : "Save" }));
  }

  _showError(message) {
    if (!this._error) return;
    this._error.textContent = "";
    this._error.append(icon("alert"), h("span", { text: message }));
    this._error.hidden = false;
    if (typeof this._error.scrollIntoView === "function") this._error.scrollIntoView({ block: "nearest" });
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
      this._showError("There are unsaved changes. Closing again discards them.");
      return;
    }
    this._close();
  }

  _close() {
    // Home Assistant listens for "dialog-closed" on the document to restore focus
    // and release its scroll lock, and reads event.detail.dialog there. Firing it
    // without a detail crashes quick-bar-mixin with
    // "Cannot read properties of null (reading 'dialog')".
    this.dispatchEvent(
      new CustomEvent("dialog-closed", {
        bubbles: true,
        composed: true,
        detail: { dialog: this.localName || "bilresa-action-editor" },
      }),
    );
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

  _focusables(root) {
    const host = root || this._dialogEl;
    if (!host) return [];
    const selector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(host.querySelectorAll(selector)).filter(
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
    if (this._textarea && this._textarea.isConnected) {
      this._textarea.focus();
      return;
    }
    const inBody = this._focusables(this._bodyHost);
    if (inBody.length) {
      inBody[0].focus();
      return;
    }
    const items = this._focusables();
    if (items.length) items[0].focus();
  }
}

/** Entity domains a guided step accepts when the type is switched. */
const ENTITY_DOMAINS = {
  script: ["script"],
  scene: ["scene"],
  button: ["button", "input_button"],
  select: ["input_select", "select"],
};

let fieldCounter = 0;

/* ------------------------------------------------------------------ styles -- */

const DIALOG_STYLES = `
/* The rules below set display on elements the dialog toggles via .hidden, and
   an author rule beats the user-agent [hidden] rule no matter the order. */
[hidden] { display: none !important; }

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
  width: min(880px, 100%);
  max-height: min(88vh, 920px);
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
  flex-wrap: wrap;
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

/* ------------------------------------------------------------ simple view -- */

.simple { display: flex; flex-direction: column; gap: var(--bil-gap); }
.simple-lead { margin: 0; }

.simple-empty {
  padding: 20px var(--bil-gap);
  border: 1px dashed var(--divider-color, rgba(127, 127, 127, 0.28));
  border-radius: var(--bil-radius-md);
  text-align: center;
}

.simple-empty p { margin: 4px 0 0; }

.steps { display: flex; flex-direction: column; gap: 12px; }

.step { padding: 12px; }

.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.step-num {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-accent) 16%, transparent);
  color: var(--bil-accent);
  font-size: 13px;
  font-weight: 700;
}

.step-head select.step-type { flex: 1 1 220px; width: auto; min-width: 0; }

.step-tools { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.icon-btn.small-icon { width: 40px; height: 40px; }
.icon-btn.small-icon .icon { width: 18px; height: 18px; }

.step-body { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.step-body:empty { margin-top: 0; }

.sub-field { display: flex; flex-direction: column; gap: 8px; }
.sub-field:empty { display: none; }

.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.seg {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 3px;
  border: var(--bil-border);
  border-radius: var(--bil-pill);
  align-self: flex-start;
  max-width: 100%;
}

.seg-btn {
  min-height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--bil-pill);
  background: transparent;
  color: var(--bil-text-dim);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.seg-btn.is-active { background: var(--bil-accent); color: var(--bil-on-accent); }
.seg-btn:focus-visible { outline: 2px solid var(--bil-accent); outline-offset: 2px; }

.target-list { display: flex; flex-direction: column; gap: 8px; }
.target-row { display: flex; align-items: flex-start; gap: 6px; }
.target-row > *:first-child { flex: 1 1 auto; min-width: 0; }
.add-target { align-self: flex-start; min-height: 32px; font-size: 13px; }

.range-row { display: flex; align-items: center; gap: 12px; }
.range-row input[type="range"] { flex: 1 1 auto; min-width: 0; height: 44px; accent-color: var(--bil-accent); }
.range-value { flex: none; min-width: 4ch; text-align: right; font-variant-numeric: tabular-nums; }

.kv { display: flex; flex-direction: column; gap: 8px; }
.kv-row { display: flex; align-items: center; gap: 6px; }
.kv-row input { flex: 1 1 120px; min-width: 0; }
.kv p { margin: 0; }

.step-add .btn { min-height: 44px; }

/* -------------------------------------------------------------- combo box -- */

.combo { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.combo-hint { margin: 0; overflow-wrap: anywhere; }
.combo-hint:empty { display: none; }

.combo-list {
  display: flex;
  flex-direction: column;
  max-height: 240px;
  overflow: auto;
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
  background: var(--bil-surface);
  box-shadow: var(--bil-shadow-1);
}

.combo-opt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-height: 44px;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.combo-opt:hover, .combo-opt.is-active { background: color-mix(in srgb, var(--bil-accent) 12%, transparent); }
.combo-opt .combo-name { overflow-wrap: anywhere; }
.combo-empty { margin: 0; padding: 12px; }

/* ---------------------------------------------------------------- yaml -- */

.yaml-wrap { display: flex; flex-direction: column; gap: 10px; }
.yaml-tools { align-items: center; }
.yaml-tools span { min-width: 0; overflow-wrap: anywhere; }

.yaml-area {
  width: 100%;
  min-height: 240px;
  resize: vertical;
  font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 13px;
  line-height: 1.6;
  tab-size: 2;
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}

.vars {
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
  padding: 4px 12px;
}

.vars > summary {
  min-height: 40px;
  display: flex;
  align-items: center;
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
}

.vars > summary:focus-visible { outline: 2px solid var(--bil-accent); outline-offset: 2px; }
.vars p { margin: 8px 0 10px; }

.vars-list { margin: 8px 0; display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 4px 12px; }
.vars-list dt { font-size: 13px; color: var(--bil-accent); overflow-wrap: anywhere; }
.vars-list dd { margin: 0; font-size: 13px; color: var(--bil-text-dim); }

.vars-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--bil-pill);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text-dim) 16%, transparent);
  color: var(--bil-text-dim);
  font-family: var(--ha-font-family-body, inherit);
  font-size: 11px;
  font-weight: 600;
}

/* -------------------------------------------------------- notes & errors -- */

.dialog-error, .dialog-note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0 var(--bil-gap-lg) var(--bil-gap);
  padding: 12px 14px;
  border-radius: var(--bil-radius-md);
  font-size: 13px;
}

.dialog-error {
  border-left: 3px solid var(--bil-error);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-error) 12%, var(--bil-surface));
}

.dialog-note {
  margin: 12px var(--bil-gap-lg) 0;
  border-left: 3px solid var(--bil-accent);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-accent) 10%, var(--bil-surface));
}

.dialog-error .icon { color: var(--bil-error); flex: none; }
.dialog-note .icon { color: var(--bil-accent); flex: none; }
.dialog-error span, .dialog-note span { min-width: 0; overflow-wrap: anywhere; }

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
  .switch-btn { flex: 1 1 auto; justify-content: center; }
  .dialog-error { margin-left: var(--bil-gap); margin-right: var(--bil-gap); }
  .dialog-note { margin-left: var(--bil-gap); margin-right: var(--bil-gap); }
  .mode-field { flex: 1 1 100%; max-width: none; }
  .dialog-foot .btn { flex: 1 1 auto; }
  .step-head select.step-type { flex: 1 1 100%; order: 3; }
  .step-tools { margin-left: auto; }
  .vars-list { grid-template-columns: 1fr; gap: 0 0; }
  .vars-list dd { margin-bottom: 8px; }
}
`;

if (!customElements.get("bilresa-action-editor")) {
  customElements.define("bilresa-action-editor", BilresaActionEditor);
}

export { BilresaActionEditor, YamlError, StepError, stepToAction, actionToStep, stepsFromSequence };
