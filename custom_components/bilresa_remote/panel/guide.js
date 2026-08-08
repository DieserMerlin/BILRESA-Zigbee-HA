/**
 * <bilresa-guide> — the manual that used to live in the config flow.
 *
 * Static, typeset content; the only dynamic parts are the Zigbee group ids and
 * the MQTT base topic, which are taken from the `config` payload when the shell
 * hands one over. Written in English on purpose: the wording matches the terms
 * Zigbee2MQTT itself uses, so copying a term into its UI works.
 */

import { sharedStyles } from "./styles.js";

/** Illustration served by the integration; the beige housing reads best. */
const IMAGE_URL = "/bilresa_remote/images/bilresa-beige.svg";

/** Fallbacks for the two values the guide can read from the config payload. */
const DEFAULT_GROUP_IDS = Object.freeze([21658, 21659, 21660]);
const DEFAULT_BASE_TOPIC = "zigbee2mqtt";

/** Example address used in the payload samples; the same one as in the README. */
const SAMPLE_IEEE = "0x1035970000a197b8";

const ICONS = {
  info: "M13 9h-2V7h2m0 10h-2v-6h2m-1-9A10 10 0 0 0 2 12a10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2",
  alert: "M13 14h-2V9h2m0 9h-2v-2h2M1 21h22L12 2z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  key: "M7 14a2 2 0 1 1 2-2 2 2 0 0 1-2 2m5.65-4A5.99 5.99 0 0 0 1 12a6 6 0 0 0 11.65 2H17v4h4v-4h2v-4z",
  wrench:
    "M22.7 19 13.6 9.9a5.5 5.5 0 0 0-6.9-7.1l3.6 3.6-2.5 2.5-3.6-3.6a5.5 5.5 0 0 0 7.1 6.9l9.1 9.1a1 1 0 0 0 1.4 0l.9-.9a1 1 0 0 0 0-1.4",
};

/* --------------------------------------------------------------- helpers -- */

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

/** Inline monospace token. */
function code(text) {
  return h("code", { text: String(text) });
}

/**
 * Paragraph with inline markup. Parts are strings or nodes, so a sentence can
 * carry a <code> without resorting to innerHTML.
 */
function p(...parts) {
  return h("p", {}, parts);
}

function strong(text) {
  return h("strong", { text: String(text) });
}

/** Highlighted box. `kind` is one of accent | warn | good. */
function box(kind, iconName, title, ...content) {
  return h(
    "aside",
    { class: `box ${kind}` },
    icon(iconName),
    h("div", { class: "box-body" }, h("strong", { text: title }), content)
  );
}

/** Table with a horizontally scrollable wrapper — narrow screens must not push
 *  the page sideways. */
function table(headers, rows) {
  const head = h(
    "tr",
    {},
    headers.map((label) => h("th", { scope: "col", text: label }))
  );
  const body = rows.map((cells) =>
    h(
      "tr",
      {},
      cells.map((cell) =>
        h("td", {}, cell && cell.nodeType ? cell : document.createTextNode(String(cell ?? "")))
      )
    )
  );
  return h(
    "div",
    { class: "table-wrap" },
    h("table", {}, h("thead", {}, head), h("tbody", {}, body))
  );
}

/** Yes/no marker for the "carries the channel" column. */
function flag(value) {
  if (value === true) return h("span", { class: "chip success", text: "yes" });
  if (value === false) return h("span", { class: "chip error", text: "no" });
  return h("span", { class: "chip neutral", text: "—" });
}

/**
 * Code block. `lines` are strings; a line may be given as { text, mark } to
 * highlight it — used to point at the presence or absence of action_group.
 */
function codeBlock(caption, lines) {
  const pre = h("pre", { tabindex: "0" });
  const codeEl = h("code", {});
  lines.forEach((line, index) => {
    const raw = typeof line === "string" ? line : line.text;
    const marked = typeof line === "object" && line.mark;
    codeEl.append(marked ? h("span", { class: "mark", text: raw }) : document.createTextNode(raw));
    if (index < lines.length - 1) codeEl.append(document.createTextNode("\n"));
  });
  pre.append(codeEl);
  return h(
    "figure",
    { class: "code-figure" },
    caption ? h("figcaption", {}, caption) : null,
    pre
  );
}

/** Numbered step list. Items: { n, title, body: [nodes], extra: node }. */
function steps(items) {
  return h(
    "ol",
    { class: "steps" },
    items.map((item) =>
      h(
        "li",
        { class: "step" },
        h("span", { class: "step-num", "aria-hidden": "true", text: String(item.n) }),
        h(
          "div",
          { class: "step-body" },
          // The number is in the badge; screen readers get it from here, because
          // a list without markers is not reliably announced as one.
          h(
            "p",
            { class: "step-title" },
            h("span", { class: "sr-only", text: `Step ${item.n}: ` }),
            strong(item.title)
          ),
          item.body || [],
          item.extra || null
        )
      )
    )
  );
}

/* ---------------------------------------------------------------- styles -- */

const guideStyles = `
.guide {
  display: flex;
  flex-direction: column;
  gap: var(--bil-gap-lg);
  max-width: 920px;
  margin: 0 auto;
}

.guide-head h1 {
  margin: 0;
  font-size: 27px;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.guide-head .lede {
  margin: 10px 0 0;
  max-width: 66ch;
  font-size: 15px;
  color: var(--bil-text-dim);
}

/* ------------------------------------------------------------------ toc -- */

.toc {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}

.toc button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 14px;
  border: var(--bil-border);
  border-radius: var(--bil-pill);
  background: transparent;
  color: var(--bil-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.toc button:hover { background: color-mix(in srgb, var(--bil-text) 7%, transparent); }
.toc button:focus-visible { outline: 2px solid var(--bil-accent); outline-offset: 2px; }

.toc b {
  font-variant-numeric: tabular-nums;
  color: var(--bil-accent);
}

/* -------------------------------------------------------------- section -- */

.doc { scroll-margin-top: 128px; }

.doc-head { margin-bottom: 16px; }

.doc-kicker {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--bil-accent);
}

.doc h2 {
  margin: 0;
  font-size: 21px;
  line-height: 1.25;
  font-weight: 650;
  letter-spacing: -0.005em;
}

.doc h3 {
  margin: 28px 0 10px;
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.005em;
}

.doc h3:first-of-type { margin-top: 20px; }

.doc p { margin: 0 0 12px; max-width: 72ch; line-height: 1.65; }
.doc p:last-child { margin-bottom: 0; }
.doc .sub { color: var(--bil-text-dim); }

.doc ul.plain {
  margin: 0 0 12px;
  padding-left: 20px;
  max-width: 72ch;
  line-height: 1.65;
}

.doc ul.plain li { margin-bottom: 6px; }
.doc ul.plain li:last-child { margin-bottom: 0; }

/* Jump link inside running text: inline-block plus padding keeps the tap area
   comfortable without turning the link into its own block. */
.doc .link { display: inline-block; padding: 6px 0; line-height: 1.4; }

/* ---------------------------------------------------------------- code --- */

code {
  font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 0.9em;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text) 9%, transparent);
  overflow-wrap: anywhere;
}

.code-figure { margin: 0; }

.code-figure figcaption {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--bil-text-dim);
}

.code-figure figcaption code { font-size: 0.95em; }

pre {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text) 5%, var(--bil-surface));
  font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
  line-height: 1.6;
  tab-size: 2;
}

pre code {
  padding: 0;
  background: none;
  font-size: inherit;
  white-space: pre;
}

pre .mark {
  border-radius: 4px;
  padding: 1px 4px;
  margin: 0 -4px;
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-accent) 22%, transparent);
}

.payloads {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--bil-gap);
  margin-bottom: 12px;
}

/* --------------------------------------------------------------- table --- */

.table-wrap {
  overflow-x: auto;
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
  margin-bottom: 16px;
}

table {
  width: 100%;
  min-width: 560px;
  border-collapse: collapse;
  font-size: 13px;
}

th {
  text-align: left;
  padding: 10px 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--bil-text-dim);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text) 4%, transparent);
  border-bottom: var(--bil-border);
  white-space: nowrap;
}

td {
  padding: 11px 12px;
  vertical-align: top;
  border-bottom: 1px solid var(--divider-color, rgba(127,127,127,.3)) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--bil-text) 10%, transparent);
}

tbody tr:last-child td { border-bottom: none; }
td .chip { font-size: 11px; }

/* -------------------------------------------------------------- figure --- */

.figure {
  display: grid;
  grid-template-columns: minmax(140px, 190px) minmax(0, 1fr);
  gap: var(--bil-gap-lg);
  align-items: center;
  margin: 0 0 20px;
  padding: var(--bil-gap);
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
}

.stage {
  position: relative;
  width: 100%;
  aspect-ratio: 200 / 330;
}

.stage img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}

.stage .marker {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: var(--bil-accent);
  color: var(--bil-on-accent);
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  box-shadow: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--bil-surface) 78%, transparent);
}

.callouts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.callouts li {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.callouts .badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid var(--divider-color, rgba(127,127,127,.3)) 50%, transparent);
  border: 2px solid color-mix(in srgb, var(--bil-accent) 50%, transparent);
  color: var(--bil-accent);
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.callouts strong { display: block; margin-bottom: 2px; }
.callouts p { margin: 0; font-size: 13px; color: var(--bil-text-dim); max-width: 56ch; }

/* --------------------------------------------------------------- steps --- */

.steps {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.step {
  position: relative;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

/* Rail between two consecutive markers; the last step must not draw one. */
.step:not(:last-child)::before {
  content: "";
  position: absolute;
  left: 15px;
  top: 36px;
  bottom: -18px;
  width: 2px;
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text) 14%, transparent);
}

.step-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid var(--divider-color, rgba(127,127,127,.3)) 45%, transparent);
  border: 2px solid color-mix(in srgb, var(--bil-accent) 45%, transparent);
  background: var(--bil-surface);
  color: var(--bil-accent);
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.step-body { min-width: 0; padding-top: 3px; }
.step-title { margin: 0 0 4px; max-width: 72ch; }
.step-body p { margin: 0 0 8px; font-size: 13px; color: var(--bil-text-dim); max-width: 70ch; }
.step-body p:last-child { margin-bottom: 0; }
.step-body .box { margin-top: 10px; }

/* ----------------------------------------------------------------- box --- */

.box {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px var(--bil-gap);
  margin: 16px 0;
  border-radius: var(--bil-radius-md);
  border-left: 3px solid var(--bil-accent);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-accent) 9%, var(--bil-surface));
}

.box:first-child { margin-top: 0; }
.box:last-child { margin-bottom: 0; }
.box .icon { flex: none; margin-top: 1px; color: var(--bil-accent); }
.box-body { min-width: 0; }
.box-body strong { display: block; margin-bottom: 3px; }
.box-body p { margin: 0 0 8px; font-size: 13px; color: var(--bil-text-dim); max-width: 68ch; }
.box-body p:last-child { margin-bottom: 0; }

.box.warn { border-left-color: var(--bil-warning); background: color-mix(in srgb, var(--bil-warning) 12%, var(--bil-surface)); }
.box.warn .icon { color: var(--bil-warning); }
.box.good { border-left-color: var(--bil-success); background: color-mix(in srgb, var(--bil-success) 10%, var(--bil-surface)); }
.box.good .icon { color: var(--bil-success); }

/* Section 3 is a box in its own right, so it gets a little more presence. */
.doc.skip { border-left: 3px solid var(--bil-success); }

/* ----------------------------------------------------- troubleshooting --- */

.trouble {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}

.trouble li {
  padding: 14px var(--bil-gap);
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
}

.trouble .sym {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-weight: 650;
}

.trouble .sym .icon { width: 16px; height: 16px; color: var(--bil-text-dim); }
.trouble p { margin: 0; font-size: 13px; color: var(--bil-text-dim); max-width: 72ch; }

.guide-foot {
  margin: 0;
  padding-top: 4px;
  font-size: 12px;
  color: var(--bil-text-dim);
}

/* ---------------------------------------------------------- responsive --- */

@media (max-width: 700px) {
  .guide-head h1 { font-size: 22px; }
  .figure { grid-template-columns: minmax(0, 1fr); gap: var(--bil-gap); }
  .stage { max-width: 170px; margin: 0 auto; }
  .toc button { width: 100%; justify-content: flex-start; }
  .doc { scroll-margin-top: 104px; }
}
`;

/* ---------------------------------------------------------------- element -- */

class BilresaGuide extends HTMLElement {
  static get properties() {
    return { hass: {}, config: {} };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._signature = null;

    const style = document.createElement("style");
    style.textContent = `${sharedStyles}\n${guideStyles}`;
    this._root = h("article", { class: "guide" });
    this.shadowRoot.append(style, this._root);
  }

  set hass(hass) {
    this._hass = hass;
  }

  get hass() {
    return this._hass;
  }

  set config(config) {
    this._config = config && typeof config === "object" ? config : null;
    this._render();
    this._applyHash();
  }

  get config() {
    return this._config;
  }

  connectedCallback() {
    this._render();
    this._applyHash();
  }

  /* -------------------------------------------------------------- data -- */

  /** Group ids of the three channels; from the config when a remote has them. */
  _groupIds() {
    const remotes =
      this._config && Array.isArray(this._config.remotes) ? this._config.remotes : [];
    for (const remote of remotes) {
      const ids = remote && Array.isArray(remote.group_ids) ? remote.group_ids : [];
      const numbers = ids.map(Number).filter((value) => Number.isFinite(value));
      if (numbers.length === 3) return numbers;
    }
    return [...DEFAULT_GROUP_IDS];
  }

  _baseTopic() {
    const topic =
      this._config && typeof this._config.base_topic === "string"
        ? this._config.base_topic.trim()
        : "";
    return topic || DEFAULT_BASE_TOPIC;
  }

  /* ------------------------------------------------------------ render -- */

  _render() {
    const groups = this._groupIds();
    const topic = this._baseTopic();
    const signature = `${groups.join(",")}|${topic}`;
    // Re-rendering on every config poll would throw away the reading position.
    if (this._signature === signature && this._root.childElementCount) return;
    this._signature = signature;

    this._root.textContent = "";
    this._root.append(
      this._head(),
      this._sectionButtons(groups),
      this._sectionUnlock(groups),
      this._sectionSkip(),
      this._sectionModeSource(groups),
      this._sectionMulticlick(groups, topic),
      this._sectionTroubleshooting(topic),
      h("p", {
        class: "guide-foot",
        text:
          "Everything on this page was measured on real hardware with Zigbee2MQTT 2.13.0. " +
          "If your remote behaves differently, that is a finding worth reporting.",
      })
    );
  }

  _head() {
    const entries = [
      ["1", "What this remote can do", "sec-buttons"],
      ["2", "Unlocking the three channels", "sec-unlock"],
      ["3", "You can skip all of this", "sec-skip"],
      ["4", "Where the mode comes from", "sec-source"],
      ["5", "Double and triple click", "sec-multiclick"],
      ["6", "Troubleshooting", "sec-trouble"],
    ];
    return h(
      "header",
      { class: "guide-head" },
      h("h1", { text: "Using the BILRESA remote" }),
      h("p", {
        class: "lede",
        text:
          "One wheel, three internal channels and a lower button that sends nothing at all. " +
          "This page explains what the hardware really does, how to unlock the second and " +
          "third channel, and why you do not have to.",
      }),
      h(
        "nav",
        { class: "toc", "aria-label": "On this page" },
        entries.map(([number, label, id]) =>
          h(
            "button",
            { type: "button", onclick: () => this._scrollTo(id) },
            h("b", { text: number }),
            h("span", { text: label })
          )
        )
      )
    );
  }

  _scrollTo(id) {
    const target = this.shadowRoot.getElementById(id);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /**
   * Jump to the section named in the URL fragment — that is how the remote
   * editor links into this page. The fragment is consumed afterwards, so
   * opening the guide again later starts at the top.
   */
  _applyHash() {
    const location = typeof window !== "undefined" ? window.location : null;
    const id = String((location && location.hash) || "").replace(/^#/, "");
    if (!id || !this.shadowRoot.getElementById(id)) return;
    try {
      window.history.replaceState(null, "", `${location.pathname}${location.search || ""}`);
    } catch (err) {
      // A browser that refuses the rewrite still gets the scroll below.
    }
    requestAnimationFrame(() => this._scrollTo(id));
  }

  /** Link that scrolls to another section of this page. */
  _jump(id, label) {
    return h(
      "button",
      { type: "button", class: "link", onclick: () => this._scrollTo(id) },
      h("span", { text: label })
    );
  }

  /* ------------------------------------------------ 1 · button reference -- */

  _sectionButtons(groups) {
    const section = h("section", { class: "card pad-lg doc", id: "sec-buttons" });
    section.append(
      h(
        "div",
        { class: "doc-head" },
        h("p", { class: "doc-kicker", text: "Section 1" }),
        h("h2", { text: "What this remote can do" })
      ),
      p(
        "There is exactly one clickable surface on this remote: the wheel. Everything below ",
        "was measured on real hardware — it differs from the product documentation in places."
      ),
      this._figure(),
      table(
        ["What you do", "Zigbee2MQTT action", "This integration", "Carries the channel"],
        [
          [
            "Click the wheel once",
            h("span", {}, code("on"), " / ", code("off"), " alternating"),
            h("span", {}, code("click"), " — split into ", code("click_on"), " / ", code("click_off"), " on request"),
            flag(true),
          ],
          ["Click the wheel twice", code("on_double"), code("double"), flag(false)],
          ["Click the wheel three times", code("off_double"), code("triple"), flag(false)],
          [
            "Turn the wheel",
            h("span", {}, code("brightness_move_to_level"), " with ", code("action_level")),
            h("span", {}, code("wheel"), " — absolute value 1…255"),
            flag(true),
          ],
          [
            "Press the lower button",
            h("em", { text: "nothing is sent" }),
            "selects the channel inside the remote — nothing else",
            flag(null),
          ],
          [
            "Four or more clicks, long press",
            h("em", { text: "nothing is sent" }),
            "—",
            flag(null),
          ],
        ]
      ),
      h("h3", { text: "The four details that surprise everybody" }),
      h(
        "ul",
        { class: "plain" },
        h(
          "li",
          {},
          strong("A single click alternates between on and off."),
          " That is a counter inside the remote, not the state of anything in your home. " +
            "Both halves map to the same action unless you split them per remote."
        ),
        h(
          "li",
          {},
          strong("The lower button is a channel selector, nothing else."),
          " It picks which of the three channels the wheel sends on and sends nothing over " +
            "Zigbee itself. It can never be bound to an action, Home Assistant only notices the " +
            "new channel with the next click or turn, and with the mode source ",
          strong("Internal"),
          " it has no effect at all."
        ),
        h(
          "li",
          {},
          strong("off_double is the triple click."),
          " The raw name is misleading; three clicks produce ",
          code("off_double"),
          ", verified repeatedly."
        ),
        h(
          "li",
          {},
          strong("The wheel reports an absolute level, never a step."),
          " The value runs from 1 to 255, is shared by all three channels, and ",
          code("null"),
          " means 255."
        )
      ),
      h("h3", { text: "A wheel turn on the wire" }),
      codeBlock(
        h("span", {}, "Topic ", code(`${this._baseTopic()}/${SAMPLE_IEEE}`), " — wheel turn on channel 1"),
        [
          "{",
          '  "action": "brightness_move_to_level",',
          { text: `  "action_group": ${groups[0]},`, mark: true },
          '  "action_level": 45,',
          '  "action_transition_time": 1,',
          '  "battery": 100,',
          '  "linkquality": 105,',
          '  "voltage": 0',
          "}",
        ]
      ),
      box(
        "accent",
        "info",
        "The channel is a group id, never a remote",
        p(
          "Every BILRESA in your network sends to the same three ids — ",
          code(String(groups[0])),
          ", ",
          code(String(groups[1])),
          " and ",
          code(String(groups[2])),
          ". Which remote pressed is decided by the topic it publishes on, not by the group."
        )
      )
    );
    return section;
  }

  /** Illustration with numbered markers plus the matching callout list. */
  _figure() {
    // Coordinates of the shipped illustration (viewBox 200x330): the wheel sits
    // at cy 104 (31.5%), the LED row at cy 216 (65.45%).
    const markers = [
      { n: 1, left: "50%", top: "31.5%" },
      { n: 2, left: "29%", top: "65.45%" },
      { n: 3, left: "50%", top: "82%" },
    ];
    const callouts = [
      {
        n: 1,
        title: "The scroll wheel",
        text:
          "The only clickable surface. Click it once, twice or three times, or turn it — " +
          "a turn reports an absolute level from 1 to 255.",
      },
      {
        n: 2,
        title: "The three channel LEDs",
        text:
          "They show which internal channel is active. Until the channels are unlocked only " +
          "the first one ever lights up.",
      },
      {
        n: 3,
        title: "The lower button — the channel switch",
        text:
          "Its only job is to move to the next channel. It sends nothing over Zigbee, so the " +
          "new channel becomes visible only with the next click or turn, and it can never be " +
          "bound to an action. It sits below the LEDs and is not drawn here. The pairing button " +
          "used in the unlocking steps is a different button.",
      },
    ];

    const stage = h(
      "div",
      { class: "stage" },
      h("img", {
        src: IMAGE_URL,
        alt: "IKEA BILRESA remote, seen from the front",
        draggable: "false",
      }),
      markers.map((marker) =>
        h("span", {
          class: "marker",
          "aria-hidden": "true",
          text: String(marker.n),
          style: { left: marker.left, top: marker.top },
        })
      )
    );

    return h(
      "figure",
      { class: "figure" },
      stage,
      h(
        "ol",
        { class: "callouts" },
        callouts.map((item) =>
          h(
            "li",
            {},
            h("span", { class: "badge", "aria-hidden": "true", text: String(item.n) }),
            h("div", {}, strong(item.title), h("p", { text: item.text }))
          )
        )
      )
    );
  }

  /* -------------------------------------------------- 2 · touchlink unlock -- */

  _sectionUnlock(groups) {
    const section = h("section", { class: "card pad-lg doc", id: "sec-unlock" });
    section.append(
      h(
        "div",
        { class: "doc-head" },
        h("p", { class: "doc-kicker", text: "Section 2" }),
        h("h2", { text: "Unlocking the three channels" })
      ),
      p(
        "Out of the box the remote sends everything to the first group and the lower button ",
        "does nothing. The three channels have to be unlocked once, by hand, with Touchlink. ",
        "Plan five minutes; afterwards the remote keeps them forever."
      ),
      box(
        "warn",
        "alert",
        "This happens physically at the remote",
        p(
          "Touchlink here runs directly between the remote and a lamp; the coordinator is not ",
          "involved. The Touchlink page in Zigbee2MQTT cannot start it for you — the remote ",
          "initiates the scan itself when you press its pairing button, so every step below is ",
          "a press on the device."
        )
      ),
      h("h3", { text: "Pair the remote with Zigbee2MQTT" }),
      steps([
        {
          n: 1,
          title: "Reset the remote",
          body: [h("p", { text: "Hold the pairing button for 10 seconds." })],
        },
        {
          n: 2,
          title: "Press the pairing button 4 times quickly",
          body: [h("p", { text: "Keep going until the first LED responds." })],
        },
        {
          n: 3,
          title: "Press 8 times quickly so Zigbee2MQTT can find the remote",
          body: [
            p(
              "Permit join has to be switched on in Zigbee2MQTT while you do this, otherwise ",
              "the remote finds nothing to join."
            ),
          ],
        },
      ]),
      h("h3", { text: "Touchlink every channel" }),
      steps([
        {
          n: 4,
          title: "Pick a dummy Zigbee device in Zigbee2MQTT",
          body: [
            h("p", {
              text:
                "Anything you can safely play with; a plain bulb is ideal. The same device is " +
                "used for all three channels.",
            }),
          ],
        },
        {
          n: 5,
          title: "Press the pairing button 4 times quickly, right next to that device",
          body: [
            h("p", {
              text:
                "Hold the remote close to the bulb. Those four presses start Touchlink for the " +
                "channel the remote is currently on.",
            }),
          ],
        },
        {
          n: 6,
          title: "Repeat for the second channel",
          body: [
            p(
              "Once Touchlink has succeeded, press 4 times again, switch to the second LED with ",
              "the lower button, and run the same Touchlink against the same dummy device."
            ),
          ],
        },
        {
          n: 7,
          title: "Repeat for the third channel",
          body: [
            h("p", {
              text:
                "After this all three LEDs are usable and the lower button really switches " +
                "channels.",
            }),
          ],
        },
      ]),
      h("h3", { text: "Teach the remote its groups" }),
      steps([
        {
          n: 8,
          title: "Create the three groups in Zigbee2MQTT",
          body: [
            p(
              "The ids have to be exactly ",
              code(String(groups[0])),
              ", ",
              code(String(groups[1])),
              " and ",
              code(String(groups[2])),
              " — that is channel 1, channel 2 and channel 3. The remote uses these ids ",
              "internally; they are not a choice."
            ),
          ],
        },
        {
          n: 9,
          title: "Add the dummy device to all three groups",
          body: [
            h("p", {
              text:
                "This is what makes Zigbee2MQTT write the group membership into the remote.",
            }),
          ],
        },
        {
          n: 10,
          title: "Remove the dummy device from all three groups again",
          body: [
            h("p", {
              text:
                "This is not tidying up, it is the point of the whole exercise.",
            }),
          ],
          extra: box(
            "accent",
            "key",
            "Why removing it is the actual goal",
            p(
              "Adding and removing the device teaches the remote the three group ids — that ",
              "knowledge stays in the remote. What goes away is the direct Touchlink binding, ",
              "so the bulb stops reacting on its own."
            ),
            p(
              "What remains is exactly what this integration needs: the remote groupcasts to ",
              code(String(groups[0])),
              ", ",
              code(String(groups[1])),
              " or ",
              code(String(groups[2])),
              ", Zigbee2MQTT reports the id as ",
              code("action_group"),
              ", and Home Assistant decides what happens. Leave the dummy device in the groups ",
              "and every press does two things at once: the direct Zigbee command and your action."
            )
          ),
        },
      ]),
      box(
        "good",
        "check",
        "How to tell it worked",
        p(
          "Press the lower button, then click the wheel: the mode on the remote's page follows ",
          "along, and the live strip shows the new channel. If it always stays on channel 1, the ",
          "unlock did not take."
        )
      )
    );
    return section;
  }

  /* ------------------------------------------------------ 3 · skip it all -- */

  _sectionSkip() {
    const section = h("section", { class: "card pad-lg doc skip", id: "sec-skip" });
    section.append(
      h(
        "div",
        { class: "doc-head" },
        h("p", { class: "doc-kicker", text: "Section 3" }),
        h("h2", { text: "You can skip all of this" })
      ),
      p(
        "Nothing above is mandatory. Set the mode source of a remote to ",
        strong("Internal"),
        " and the integration switches modes on its own — no Touchlink, no groups, no dummy ",
        "device, and all modes work on a remote straight out of the box."
      ),
      box(
        "good",
        "check",
        "The price: one action is spent on switching",
        p(
          "With ",
          strong("Internal"),
          " one press has to advance the mode — the triple click by default, and you can pick a ",
          "different one per remote. That action is no longer free for anything else. Everything ",
          "else stays exactly as it is."
        ),
        p(
          "Unsure? ",
          strong("Hybrid"),
          " is the default: it behaves like Internal until it sees a channel other than the ",
          "first one even once, and then follows the hardware permanently."
        )
      ),
      h(
        "p",
        { class: "sub" },
        "The unlock is worth doing only if you want the lower button on the remote itself to ",
        "switch modes. ",
        this._jump("sec-source", "What exactly do the three mode sources do?")
      )
    );
    return section;
  }

  /* ---------------------------------------------------- 4 · mode source -- */

  _sectionModeSource(groups) {
    const section = h("section", { class: "card pad-lg doc", id: "sec-source" });
    section.append(
      h(
        "div",
        { class: "doc-head" },
        h("p", { class: "doc-kicker", text: "Section 4" }),
        h("h2", { text: "Where the mode comes from" })
      ),
      p(
        "The remote has three internal channels. The lower button switches between them and the ",
        "LED shows the active one — all of that happens inside the remote and never touches ",
        "Zigbee. The only open question is how Home Assistant learns which channel is on, and ",
        "that is what the ",
        strong("mode source"),
        " of a remote answers. It is one setting with three answers."
      ),
      table(
        ["Mode source", "How Home Assistant finds the mode", "Who it is for"],
        [
          [
            strong("Device"),
            h(
              "span",
              {},
              "Out of the radio traffic. A single click and the wheel are addressed to a group id (",
              code(String(groups[0])),
              ", ",
              code(String(groups[1])),
              ", ",
              code(String(groups[2])),
              ") and Zigbee2MQTT reports it as ",
              code("action_group"),
              " — that id names the channel."
            ),
            "Remotes whose three channels were unlocked with Touchlink.",
          ],
          [
            strong("Internal"),
            "Not from the remote at all. Home Assistant keeps its own counter and advances it " +
              "whenever the action you picked is triggered — a triple click by default.",
            "Everyone who did not run the Touchlink procedure. The lower button stays without " +
              "effect here.",
          ],
          [
            h("span", {}, strong("Hybrid"), " (default)"),
            "Starts out like Internal and switches over to Device on its own, the first time a " +
              "group id other than the first one shows up.",
            "Everyone who is not sure, and anyone planning to unlock the channels later.",
          ],
        ]
      ),
      h("h3", { text: "Which one do I need?" }),
      h(
        "ul",
        { class: "plain" },
        h(
          "li",
          {},
          strong("You worked through section 2 and the LEDs follow the lower button: "),
          "take ",
          strong("Device"),
          ". Nothing else has to be configured — the channel arrives with every press.",
          " ",
          this._jump("sec-unlock", "How do I unlock the channels?")
        ),
        h(
          "li",
          {},
          strong("You did not, and you do not want to: "),
          "take ",
          strong("Internal"),
          ". Pick which action advances the mode; that one action is then spent on switching."
        ),
        h(
          "li",
          {},
          strong("You are not sure: "),
          "leave it on ",
          strong("Hybrid"),
          ". It behaves like Internal today and follows the hardware the moment the channels " +
            "start working, without you changing anything."
        )
      ),
      box(
        "accent",
        "info",
        "The panel shows what is actually in use",
        p(
          "Hybrid is the setting, but not necessarily what is running. Once it has promoted ",
          "itself, the remote's page says ",
          strong("Currently using: Device"),
          " — the setting stays on Hybrid, the mode comes from the hardware. The promotion is ",
          "permanent for that remote."
        )
      ),
      box(
        "warn",
        "alert",
        "With Internal the lower button does nothing",
        p(
          "The button still switches the channel inside the remote, and the LED still moves, but ",
          "Home Assistant ignores the group ids and counts on its own. The two can then disagree: ",
          "what counts for your actions is the mode shown in the panel, not the LED on the remote."
        )
      ),
      h(
        "p",
        { class: "sub" },
        "The group ids only matter for Device and Hybrid. They are a per-remote setting because ",
        "the ids are fixed in the hardware — you normally never touch them."
      )
    );
    return section;
  }

  /* --------------------------------------------- 5 · multiclick and modes -- */

  _sectionMulticlick(groups, topic) {
    const section = h("section", { class: "card pad-lg doc", id: "sec-multiclick" });
    section.append(
      h(
        "div",
        { class: "doc-head" },
        h("p", { class: "doc-kicker", text: "Section 5" }),
        h("h2", { text: "Why double and triple click ignore the channel" })
      ),
      p(
        "A single click and a wheel turn are ",
        strong("groupcasts"),
        ": the frame is addressed to the Zigbee group of the active channel (",
        code(String(groups[0])),
        ", ",
        code(String(groups[1])),
        " or ",
        code(String(groups[2])),
        "). Zigbee2MQTT reads the destination group out of the frame and publishes it as ",
        code("action_group"),
        ". That field is the only place where the channel is visible."
      ),
      p(
        "A double or triple click is not a groupcast. The remote sends it as a ",
        strong("unicast"),
        " command towards the coordinator, and a unicast frame has no destination group. There ",
        "is nothing for Zigbee2MQTT to report, so its converter emits no ",
        code("action_group"),
        " at all. The information was never transmitted; no integration can recover it."
      ),
      h("h3", { text: "The same remote, two presses" }),
      h(
        "div",
        { class: "payloads" },
        codeBlock(
          h("span", {}, "Single click on channel 1 — ", code(`${topic}/${SAMPLE_IEEE}`)),
          [
            "{",
            '  "action": "on",',
            { text: `  "action_group": ${groups[0]},`, mark: true },
            '  "battery": 100,',
            '  "linkquality": 114,',
            '  "voltage": 0',
            "}",
          ]
        ),
        codeBlock(
          h("span", {}, "Double click, same remote, same channel"),
          [
            "{",
            '  "action": "on_double",',
            '  "battery": 100,',
            '  "identify": null,',
            '  "linkquality": 114,',
            '  "voltage": 0',
            "}",
          ]
        )
      ),
      h(
        "p",
        { class: "sub" },
        "The second payload has no ",
        code("action_group"),
        " line. On channel 2 the first payload would read ",
        code(`"action_group": ${groups[1]}`),
        "; the second one would not change at all."
      ),
      h("h3", { text: "What the integration does about it" }),
      p(
        "Both reasonable answers are supported, and you choose per remote with the ",
        strong("mode-independent multiclick"),
        " switch:"
      ),
      table(
        ["Setting", "Behaviour"],
        [
          [
            h("span", {}, strong("On"), " (default)"),
            "Double and triple click are mode-independent: one binding per remote, stored under " +
              "the key “*”, and the current mode is ignored. Best for global shortcuts — " +
              "all lights off, dismiss a notification, start a scene.",
          ],
          [
            strong("Off"),
            "Double and triple click use the last known mode, that is the channel of the most " +
              "recent single click or wheel turn. One binding per mode, at the price of being " +
              "wrong for one press after a channel change.",
          ],
        ]
      ),
      box(
        "accent",
        "info",
        "Switching it never orphans a binding",
        p(
          "If bindings exist under both schemes, the switch only decides which one is tried ",
          "first; the other stays as a fallback. And with the mode source ",
          strong("Internal"),
          " the mode never comes from the hardware anyway, so “off” simply means “use ",
          "the mode the integration believes in”, which is always correct."
        )
      )
    );
    return section;
  }

  /* ----------------------------------------------------- 6 · troubleshooting -- */

  _sectionTroubleshooting(topic) {
    const entries = [
      {
        symptom: "No devices are found",
        body: p(
          "Discovery reads the retained topic ",
          code(`${topic}/bridge/devices`),
          ". Check that the MQTT integration is connected, that Zigbee2MQTT is running, and ",
          "that its base topic really is ",
          code(topic),
          " — if you renamed it, the integration is listening in the wrong place. Remotes that ",
          "are already set up are marked as such, they are not missing."
        ),
      },
      {
        symptom: "The mode never changes",
        body: p(
          "The channels are not unlocked, so every press arrives on the first group and the ",
          "lower button stays silent. Either work through section 2, or set the mode source to ",
          strong("Internal"),
          " and let a press cycle the mode — section 4 compares the three settings."
        ),
      },
      {
        symptom: "The LED on the remote and the mode in Home Assistant disagree",
        body: p(
          "That is the normal picture with the mode source ",
          strong("Internal"),
          ": the lower button still moves the LED, but Home Assistant counts on its own and " +
            "ignores the hardware. Either switch that remote to ",
          strong("Device"),
          " once the channels are unlocked, or go by the mode shown in the panel."
        ),
      },
      {
        symptom: "The wheel jumps or lands on the wrong value",
        body: p(
          "A fast turn produces a burst of levels. Raise the wheel throttle for that remote so ",
          "fewer of them are acted upon; the last value always arrives, the throttle only drops ",
          "the ones in between. Keep the wheel slot's script mode on ",
          code("restart"),
          " so a newer value replaces a run that is still going."
        ),
      },
      {
        symptom: "An action does not fire",
        body: p(
          "Sequences are validated before they are stored — an invalid one is rejected and ",
          "nothing is written, so check that the slot really holds what you think it does and ",
          "run it once with the test button. If the sequence is fine, the binding belongs to a ",
          "different mode: watch the live strip while you press, it names the slot that was hit."
        ),
      },
    ];

    const section = h("section", { class: "card pad-lg doc", id: "sec-trouble" });
    section.append(
      h(
        "div",
        { class: "doc-head" },
        h("p", { class: "doc-kicker", text: "Section 6" }),
        h("h2", { text: "Troubleshooting" })
      ),
      h(
        "ul",
        { class: "trouble" },
        entries.map((entry) =>
          h(
            "li",
            {},
            h("p", { class: "sym" }, icon("wrench"), h("span", { text: entry.symptom })),
            entry.body
          )
        )
      )
    );
    return section;
  }
}

if (!customElements.get("bilresa-guide")) {
  customElements.define("bilresa-guide", BilresaGuide);
}

export { BilresaGuide };
