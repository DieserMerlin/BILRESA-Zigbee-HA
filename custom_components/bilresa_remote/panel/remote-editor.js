/**
 * <bilresa-remote-editor> — the heart of the panel.
 *
 * One remote, top to bottom: identity (illustration, name, housing colour), the
 * mode tabs, the bindable slots of the selected mode, the mode independent
 * slots, where the mode comes from, the remaining settings and finally
 * deletion.
 *
 * Properties: `hass`, `remote`, `config`. Fires a composed `changed` event
 * whenever something was written, so the shell can reload the configuration.
 *
 * The element also listens to the live action stream. Pressing the wheel
 * highlights the matching row and switches to the matching mode tab — that is
 * what turns "which slot is this?" into "press it and see".
 */

import "./action-editor.js";

import { sharedStyles } from "./styles.js";
import {
  ACTION_LABELS,
  MODELESS_KEY,
  MODE_SOURCE_LABELS,
  clearBinding,
  deleteRemote,
  describeError,
  subscribeEvents,
  testBinding,
  updateRemote,
} from "./api.js";

const IMAGE_BASE = "/bilresa_remote/images";
const MODEL_LABEL = "IKEA BILRESA E2490";
const MAX_MODE_COUNT = 9;
const DEFAULT_COLORS = ["red", "beige", "green", "white"];
const DEFAULT_MODE_SOURCES = ["hybrid", "device", "internal"];
const DEFAULT_ACTIONS = ["click", "click_on", "click_off", "double", "triple", "wheel"];
const DEFAULT_GROUP_IDS = [21658, 21659, 21660];

const COLOR_LABELS = { red: "Red", beige: "Beige", green: "Green" };

/**
 * The three housing colours are the documented exception to "colours only from
 * Home Assistant variables", and they are applied as a plain inline background.
 * A custom property handed to a style object never reaches the CSSOM unless it
 * goes through setProperty — that is why the swatches used to stay colourless.
 */
const HOUSING_COLORS = {
  red: "#a94e41",
  beige: "#ccbdac",
  green: "#547d70",
  white: "#e2e2e0",
};

/** Colour of a lit channel LED, the same value the shipped SVGs use. */
const LED_ON = "#fff3d0";

/** Horizontal LED positions in percent of the illustration (cx 82/100/118 of 200). */
const LED_LEFT = [41, 50, 59];

/**
 * Slot and mode-source titles come from api.js. They used to be copied into
 * every component, which is how the panel ended up naming the same action two
 * different ways — one table is the only way that stays fixed.
 */
const ACTION_TITLES = ACTION_LABELS;
const MODE_SOURCE_TITLES = MODE_SOURCE_LABELS;

const SLOT_HINTS = {
  click: "Click the wheel once — the remote alternates between on and off.",
  click_on: "A single click while the remote is in its “on” phase.",
  click_off: "A single click while the remote is in its “off” phase.",
  double: "Click the wheel twice.",
  triple: "Click the wheel three times.",
  wheel: "Turn the wheel — an absolute value from 1 to 255.",
};

const SLOT_ICONS = {
  click: "tap",
  click_on: "tapOn",
  click_off: "tapOff",
  double: "double",
  triple: "triple",
  wheel: "wheel",
};

const SCRIPT_MODE_LABELS = {
  single: "single",
  restart: "restart",
  queued: "queued",
  parallel: "parallel",
};

const ICONS = {
  tap: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m0 2a8 8 0 1 1-8 8 8 8 0 0 1 8-8m0 3.5A4.5 4.5 0 1 0 16.5 12 4.5 4.5 0 0 0 12 7.5m0 2A2.5 2.5 0 1 1 9.5 12 2.5 2.5 0 0 1 12 9.5",
  tapOn: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m0 2a8 8 0 1 1-8 8 8 8 0 0 1 8-8m-1 3v10h2V7z",
  tapOff:
    "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m0 2a8 8 0 1 1-8 8 8 8 0 0 1 8-8m0 3.5A4.5 4.5 0 1 0 16.5 12 4.5 4.5 0 0 0 12 7.5m0 2A2.5 2.5 0 1 1 9.5 12 2.5 2.5 0 0 1 12 9.5",
  double:
    "M7 6a5 5 0 1 0 5 5 5 5 0 0 0-5-5m0 2a3 3 0 1 1-3 3 3 3 0 0 1 3-3m10 5a5 5 0 1 0 5 5 5 5 0 0 0-5-5m0 2a3 3 0 1 1-3 3 3 3 0 0 1 3-3",
  triple:
    "M6 3a3.5 3.5 0 1 0 3.5 3.5A3.5 3.5 0 0 0 6 3m6 5.5a3.5 3.5 0 1 0 3.5 3.5A3.5 3.5 0 0 0 12 8.5m6 5.5a3.5 3.5 0 1 0 3.5 3.5A3.5 3.5 0 0 0 18 14",
  wheel:
    "M12 4a8 8 0 1 0 8 8 8 8 0 0 0-8-8m0 2a6 6 0 1 1-6 6 6 6 0 0 1 6-6m0 2.5A3.5 3.5 0 1 0 15.5 12 3.5 3.5 0 0 0 12 8.5",
  pencil:
    "M20.71 7.04c.39-.39.39-1.04 0-1.41l-2.34-2.34c-.37-.39-1.02-.39-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.94l-3.75-3.75z",
  play: "M8 5.14v14l11-7z",
  trash:
    "M19 4h-3.5l-1-1h-5l-1 1H5v2h14M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6z",
  cog: "M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1s.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64z",
  info: "M13 9h-2V7h2m0 10h-2v-6h2m-1-9A10 10 0 0 0 2 12a10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2",
  alert: "M13 14h-2V9h2m0 9h-2v-2h2M1 21h22L12 2z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  cloudOff:
    "M2.5 4.27 3.78 3l16.5 16.5-1.27 1.27-2.5-2.5H6.5A4.5 4.5 0 0 1 2.44 12a4.42 4.42 0 0 1 1.9-2.62zM19.35 10A5.5 5.5 0 0 1 18.5 21h-.67l-2-2h2.67a3.5 3.5 0 0 0 .5-6.96l-1.5-.2V10.5a5.5 5.5 0 0 0-8.4-4.68L7.6 4.38A7.5 7.5 0 0 1 19.35 10",
  help:
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m1 17h-2v-2h2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26A2 2 0 0 0 12 7a2 2 0 0 0-2 2H8a4 4 0 1 1 8 0c0 .88-.36 1.68-.93 2.25",
  antenna:
    "M12 10a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2m0-6a8 8 0 0 1 8 8 8 8 0 0 1-1.69 4.9l-1.43-1.43A6 6 0 0 0 18 12a6 6 0 0 0-6-6 6 6 0 0 0-6 6 6 6 0 0 0 1.12 3.47l-1.43 1.43A8 8 0 0 1 4 12a8 8 0 0 1 8-8z",
  cycle:
    "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z",
  swap: "M21 9 17 5v3H10v2h7v3M7 11l-4 4 4 4v-3h7v-2H7v-3z",
};

/* ---------------------------------------------------------------- helpers -- */

let uidCounter = 0;

/**
 * Apply a style object. Custom properties have to go through setProperty —
 * assigning them onto the CSSStyleDeclaration is silently ignored, which is how
 * a "--swatch"-style value ends up unset and the element renders colourless.
 */
function setStyle(node, styles) {
  for (const [prop, value] of Object.entries(styles)) {
    if (value === undefined || value === null) continue;
    if (prop.startsWith("--")) node.style.setProperty(prop, String(value));
    else node.style[prop] = value;
  }
}

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key === "style" && typeof value === "object") setStyle(node, value);
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
  const path = ICONS[name] || "";
  return h("span", {
    class: extraClass ? `icon ${extraClass}` : "icon",
    "aria-hidden": "true",
    html: `<svg viewBox="0 0 24 24"><path d="${path}"/></svg>`,
  });
}

function colorLabel(color) {
  return COLOR_LABELS[color] || color || "";
}

function housingColor(color) {
  return HOUSING_COLORS[color] || "";
}

/**
 * Ink that stays readable on one of the housing colours. Derived from the
 * colour itself instead of a fourth table, so a new housing colour needs no
 * second entry anywhere.
 */
function readableInk(hex) {
  const value = String(hex || "").replace("#", "");
  if (value.length !== 6) return "#ffffff";
  const channel = (offset) => {
    const part = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.42 ? "#1f2328" : "#ffffff";
}

function actionTitle(action) {
  return ACTION_TITLES[action] || action || "";
}

function modeSourceTitle(source) {
  return MODE_SOURCE_TITLES[source] || source || "";
}

function modeNameOf(remote, mode) {
  const names = Array.isArray(remote && remote.mode_names) ? remote.mode_names : [];
  const name = names[Number(mode) - 1];
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

function modeLabel(remote, mode) {
  const name = modeNameOf(remote, mode);
  return name ? `Mode ${mode} · ${name}` : `Mode ${mode}`;
}

function groupIdsOf(remote) {
  const ids = Array.isArray(remote && remote.group_ids) ? remote.group_ids : [];
  const numbers = ids.map(Number).filter((value) => Number.isFinite(value));
  return numbers.length ? numbers : [...DEFAULT_GROUP_IDS];
}

function capitalize(text) {
  const value = String(text || "");
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/* --------------------------------------------------- sequence in plain text -- */

const DOMAIN_LABELS = {
  light: "light",
  switch: "switch",
  fan: "fan",
  cover: "cover",
  lock: "lock",
  climate: "thermostat",
  media_player: "media player",
  vacuum: "vacuum",
  humidifier: "humidifier",
  water_heater: "water heater",
  siren: "siren",
  number: "number",
  input_number: "number",
  select: "select",
  input_select: "select",
  input_boolean: "toggle",
  button: "button",
  input_button: "button",
  scene: "scene",
  script: "script",
  automation: "automation",
  notify: "notification",
  mqtt: "MQTT",
  text: "text",
  input_text: "text",
};

const SERVICE_VERBS = {
  turn_on: "turn on",
  turn_off: "turn off",
  toggle: "toggle",
  open_cover: "open",
  close_cover: "close",
  stop_cover: "stop",
  set_cover_position: "set the position of",
  set_cover_tilt_position: "set the tilt of",
  set_value: "set the value of",
  select_option: "pick an option on",
  select_next: "select the next option on",
  select_previous: "select the previous option on",
  set_temperature: "set the temperature of",
  set_hvac_mode: "set the mode of",
  set_fan_mode: "set the fan mode of",
  set_percentage: "set the speed of",
  volume_set: "set the volume of",
  volume_up: "turn up",
  volume_down: "turn down",
  volume_mute: "mute",
  media_play: "play",
  media_pause: "pause",
  media_play_pause: "play or pause",
  media_stop: "stop",
  media_next_track: "skip forward on",
  media_previous_track: "skip back on",
  play_media: "play media on",
  press: "press",
  lock: "lock",
  unlock: "unlock",
  start: "start",
  stop: "stop",
  pause: "pause",
  return_to_base: "send home",
  reload: "reload",
  trigger: "trigger",
  send_message: "send a message with",
  publish: "publish with",
};

function entityName(hass, entityId) {
  const id = String(entityId || "");
  const state = hass && hass.states ? hass.states[id] : null;
  const friendly = state && state.attributes ? state.attributes.friendly_name : "";
  if (friendly) return String(friendly);
  const object = id.includes(".") ? id.slice(id.indexOf(".") + 1) : id;
  return object.replace(/_/g, " ");
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [value];
}

function targetSummary(step, hass) {
  const target = (step && step.target) || {};
  const data = (step && step.data) || {};
  const entities = asList(target.entity_id).concat(asList(step.entity_id), asList(data.entity_id));
  if (entities.length) {
    const names = entities.slice(0, 2).map((id) => entityName(hass, id));
    return entities.length > 2 ? `${names.join(", ")} +${entities.length - 2}` : names.join(", ");
  }
  const areas = asList(target.area_id);
  if (areas.length) return areas.length === 1 ? `area ${areas[0]}` : `${areas.length} areas`;
  const devices = asList(target.device_id).concat(asList(step.device_id));
  if (devices.length) return devices.length === 1 ? "1 device" : `${devices.length} devices`;
  const labels = asList(target.label_id);
  if (labels.length) return labels.length === 1 ? `label ${labels[0]}` : `${labels.length} labels`;
  return "";
}

function formatDelay(delay) {
  if (delay === undefined || delay === null) return "";
  if (typeof delay === "number") return `${delay} s`;
  if (typeof delay === "string") return delay;
  if (typeof delay === "object") {
    const parts = [];
    if (delay.hours) parts.push(`${delay.hours} h`);
    if (delay.minutes) parts.push(`${delay.minutes} min`);
    if (delay.seconds) parts.push(`${delay.seconds} s`);
    if (delay.milliseconds) parts.push(`${delay.milliseconds} ms`);
    return parts.join(" ");
  }
  return "";
}

/** One script step as a short English phrase. */
function stepSummary(step, hass) {
  if (typeof step === "string") return step;
  if (!step || typeof step !== "object") return "Step";

  const service = step.action || step.service;
  if (typeof service === "string" && service.includes(".")) {
    const [domain, name] = service.split(".", 2);
    const who = targetSummary(step, hass);
    const verb = SERVICE_VERBS[name] || name.replace(/_/g, " ");

    if (domain === "script") {
      const target = name === "turn_on" || name === "turn_off" ? who : entityName(hass, service);
      const lead = name === "turn_off" ? "Stop script" : "Run script";
      return `${lead} ${target || ""}`.replace(/\s+/g, " ").trim();
    }
    if (domain === "scene") return `Activate scene ${who || ""}`.replace(/\s+/g, " ").trim();
    if (domain === "notify") return `Send a message via ${name}`;

    const subject = who || DOMAIN_LABELS[domain] || domain;
    return capitalize(`${verb} ${subject}`.replace(/\s+/g, " ").trim());
  }

  if (step.delay !== undefined) {
    const text = formatDelay(step.delay);
    return text ? `Wait (${text})` : "Wait";
  }
  if (step.wait_template !== undefined) return "Wait for a condition";
  if (step.wait_for_trigger !== undefined) return "Wait for a trigger";
  if (step.choose !== undefined) return "Choose (if / else)";
  if (step.if !== undefined) return "If / then";
  if (step.repeat !== undefined) return "Repeat";
  if (step.parallel !== undefined) return "Parallel steps";
  if (step.sequence !== undefined) return "Sub-sequence";
  if (step.scene !== undefined) return `Activate scene ${entityName(hass, step.scene)}`;
  if (step.event !== undefined) return `Fire the event ${step.event}`;
  if (step.variables !== undefined) return "Set variables";
  if (step.condition !== undefined) return "Check a condition";
  if (step.stop !== undefined) return "Stop";
  if (step.set_conversation_response !== undefined) return "Set the response";
  if (step.device_id !== undefined) return `Device action (${step.domain || "device"})`;
  return "Action";
}

/** The whole sequence in one line: one step verbatim, several as a count. */
function describeSequence(sequence, hass) {
  const steps = Array.isArray(sequence) ? sequence : sequence ? [sequence] : [];
  if (!steps.length) return "";
  const first = stepSummary(steps[0], hass);
  if (steps.length === 1) return first;
  return `${steps.length} steps · ${first} …`;
}

/* ------------------------------------------------------------ illustration -- */

const svgCache = new Map();

function imageUrl(color) {
  const safe = DEFAULT_COLORS.includes(color) ? color : "beige";
  return `${IMAGE_BASE}/bilresa-${safe}.svg`;
}

/**
 * The housing colour is baked into the file, and the active channel is styled
 * by rules that live *inside* the SVG — a `mode-N` class on an ancestor of an
 * <img> can never reach them. So the markup is fetched and inlined, which puts
 * the illustration's own stylesheet into this shadow root.
 */
function loadIllustration(color) {
  const safe = DEFAULT_COLORS.includes(color) ? color : "beige";
  if (!svgCache.has(safe)) {
    const promise = fetch(imageUrl(safe), { credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .catch((err) => {
        // Never cache a failure: a reload of the page should try again.
        svgCache.delete(safe);
        throw err;
      });
    svgCache.set(safe, promise);
  }
  return svgCache.get(safe);
}

/** Parse fetched markup into an <svg> node without going through innerHTML. */
function parseSvg(markup) {
  try {
    const doc = new DOMParser().parseFromString(String(markup), "image/svg+xml");
    const root = doc.documentElement;
    if (!root || String(root.nodeName).toLowerCase() !== "svg") return null;
    if (root.getElementsByTagName("parsererror").length) return null;
    return document.importNode(root, true);
  } catch (err) {
    return null;
  }
}

/* ----------------------------------------------------------------- element -- */

class BilresaRemoteEditor extends HTMLElement {
  static get properties() {
    return { hass: {}, remote: {}, config: {} };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._uid = `bil-ed-${++uidCounter}`;
    this._hass = null;
    this._remote = null;
    this._config = null;
    this._signature = "";

    // 0 until the first render: the tab then starts on the mode the device is
    // actually on, which is what the user is holding in their hand.
    this._activeMode = 0;
    this._renamingMode = 0;
    this._settingsOpen = false;
    this._confirmDelete = false;
    this._busy = false;

    this._slotRows = new Map();
    this._tabButtons = [];
    this._heroSvg = null;
    this._heroLeds = null;
    this._heroToken = 0;
    this._dialog = null;
    this._focusSelector = "";

    this._statusTimer = null;
    this._flashTimers = new Map();

    this._unsub = null;
    this._subConnection = null;
    this._subscribing = false;
    this._subFailed = false;

    this._onExternalAction = (event) => this._handleEvent(event && event.detail);
    this._lastEventKey = "";
    this._lastEventAt = 0;

    this._buildShell();
  }

  /* --------------------------------------------------------- properties -- */

  set hass(hass) {
    this._hass = hass;
    if (this._dialog) this._dialog.hass = hass;
    this._maybeSubscribe();
    if (this._remote && !this._body.childElementCount) this._render();
  }

  get hass() {
    return this._hass;
  }

  set remote(remote) {
    if (!remote || typeof remote !== "object") return;
    const signature = JSON.stringify(remote);
    this._remote = remote;
    if (signature === this._signature) return;
    this._signature = signature;
    this._clampMode();
    this._render();
  }

  get remote() {
    return this._remote;
  }

  set config(config) {
    this._config = config && typeof config === "object" ? config : null;
  }

  get config() {
    return this._config;
  }

  /** The shell hands the newest action over; own subscription is the fallback. */
  set lastEvent(event) {
    this._handleEvent(event);
  }

  /* ---------------------------------------------------------- lifecycle -- */

  connectedCallback() {
    this.addEventListener("bilresa-action", this._onExternalAction);
    this._maybeSubscribe();
    if (this._remote && !this._body.childElementCount) this._render();
  }

  disconnectedCallback() {
    this.removeEventListener("bilresa-action", this._onExternalAction);
    this._unsubscribe();
    if (this._statusTimer) clearTimeout(this._statusTimer);
    this._statusTimer = null;
    for (const timer of this._flashTimers.values()) clearTimeout(timer);
    this._flashTimers.clear();
    this._closeDialog();
  }

  _buildShell() {
    const style = document.createElement("style");
    style.textContent = `${sharedStyles}\n${EDITOR_STYLES}`;
    this._body = h("div", { class: "editor" });
    this._status = h("p", {
      class: "editor-status",
      role: "status",
      "aria-live": "polite",
      hidden: true,
    });
    this.shadowRoot.append(style, this._status, this._body);
  }

  /* ------------------------------------------------------------- events -- */

  _maybeSubscribe() {
    if (!this.isConnected || !this._hass || !this._hass.connection) return;
    if (this._subscribing) return;
    const sameConnection = this._subConnection === this._hass.connection;
    if (sameConnection && (this._unsub || this._subFailed)) return;
    if (this._unsub) this._unsubscribe();
    this._subFailed = false;
    this._subConnection = this._hass.connection;
    this._subscribe();
  }

  async _subscribe() {
    this._subscribing = true;
    try {
      const unsub = await subscribeEvents(this._hass, (event) => this._handleEvent(event));
      if (!this.isConnected) {
        Promise.resolve(unsub()).catch(() => {});
        return;
      }
      this._unsub = unsub;
    } catch (err) {
      // The shell forwards events as well, so a failure here is not fatal.
      this._subFailed = true;
    } finally {
      this._subscribing = false;
    }
  }

  _unsubscribe() {
    const unsub = this._unsub;
    this._unsub = null;
    this._subConnection = null;
    if (typeof unsub === "function") {
      try {
        Promise.resolve(unsub()).catch(() => {});
      } catch (err) {
        // Socket already gone.
      }
    }
  }

  /** Highlight the slot that was just pressed, switching tabs if needed. */
  _handleEvent(event) {
    if (!event || typeof event !== "object" || !this._remote) return;
    if (event.subentry_id !== this._remote.subentry_id) return;

    // The shell forwards the same event it also streams to us directly.
    const key = [event.action, event.mode_key, event.mode, event.level, event.timestamp].join("|");
    const now = Date.now();
    if (key === this._lastEventKey && now - this._lastEventAt < 2000) return;
    this._lastEventKey = key;
    this._lastEventAt = now;

    const mode = Number(event.mode);
    if (Number.isInteger(mode) && mode >= 1) this._setCurrentMode(mode);

    const modeKey =
      typeof event.mode_key === "string" && event.mode_key
        ? event.mode_key
        : Number.isInteger(mode)
          ? String(mode)
          : MODELESS_KEY;

    if (modeKey !== MODELESS_KEY) {
      const target = Number(modeKey);
      if (Number.isInteger(target) && target >= 1 && target <= this._modeCount() && target !== this._activeMode) {
        this._activeMode = target;
        this._renamingMode = 0;
        this._render();
      }
    }
    this._flashSlot(modeKey, event.action);
  }

  _flashSlot(modeKey, action) {
    const other = modeKey === MODELESS_KEY ? String(this._activeMode) : MODELESS_KEY;
    const candidates = [
      `${modeKey}:${action}`,
      `${other}:${action}`,
      action === "click" ? `${modeKey}:click_on` : "",
      action === "click" ? `${modeKey}:click_off` : "",
      action === "click_on" || action === "click_off" ? `${modeKey}:click` : "",
    ];
    let row = null;
    for (const candidate of candidates) {
      if (candidate && this._slotRows.has(candidate)) {
        row = this._slotRows.get(candidate);
        break;
      }
    }
    if (!row) return;

    const id = row.dataset.slot;
    const running = this._flashTimers.get(id);
    if (running) clearTimeout(running);
    row.classList.remove("is-hit");
    // Restart the animation: without the reflow a second press does nothing.
    void row.offsetWidth;
    row.classList.add("is-hit");
    this._flashTimers.set(
      id,
      setTimeout(() => {
        row.classList.remove("is-hit");
        this._flashTimers.delete(id);
      }, 1400)
    );
  }

  _setCurrentMode(mode) {
    const remote = this._remote;
    if (!remote || remote.current_mode === mode) return;
    remote.current_mode = mode;
    // Keep the signature in sync so the next config push does not re-render.
    this._signature = JSON.stringify(remote);
    this._applyCurrentMode();
  }

  _applyCurrentMode() {
    const current = Number(this._remote && this._remote.current_mode) || 1;

    if (this._heroSvg) this._paintSvgLeds(this._heroSvg, current);
    if (this._heroLeds) {
      for (const [index, dot] of this._heroLeds.entries()) {
        dot.classList.toggle("on", index + 1 === current);
      }
    }

    for (const tab of this._tabButtons) {
      const isCurrent = Number(tab.dataset.mode) === current;
      tab.classList.toggle("is-current", isCurrent);
      const badge = tab.querySelector(".tab-live");
      if (badge) badge.hidden = !isCurrent;
    }
    if (this._currentChip) {
      this._currentChip.textContent = `On the device: ${modeLabel(this._remote, current)}`;
    }
  }

  /**
   * Light the LED of the active channel inside an inlined illustration. The
   * `mode-N` class drives the glow filter declared in the SVG itself; the
   * inline fill is set as well so the LED is right even if that internal
   * stylesheet ever changes.
   */
  _paintSvgLeds(svg, current) {
    for (let i = 1; i <= 3; i += 1) svg.classList.remove(`mode-${i}`);
    if (current >= 1 && current <= 3) svg.classList.add(`mode-${current}`);
    for (let i = 1; i <= 3; i += 1) {
      const led = svg.querySelector(`#led-${i}`);
      if (!led) continue;
      const on = i === current;
      led.classList.toggle("is-active", on);
      if (on) {
        led.style.setProperty("fill", LED_ON);
        led.style.setProperty("fill-opacity", "1");
      } else {
        led.style.removeProperty("fill");
        led.style.removeProperty("fill-opacity");
      }
    }
  }

  /* ---------------------------------------------------------- utilities -- */

  _modeCount() {
    return Math.max(1, Math.min(MAX_MODE_COUNT, Number(this._remote && this._remote.mode_count) || 1));
  }

  _isModeless() {
    return this._remote ? this._remote.modeless_multiclick !== false : true;
  }

  _modeSource() {
    const source = this._remote && this._remote.mode_source;
    return typeof source === "string" && source ? source : "hybrid";
  }

  /** What actually drives the mode right now — hybrid reports device once promoted. */
  _effectiveSource() {
    const effective = this._remote && this._remote.effective_mode_source;
    return typeof effective === "string" && effective ? effective : this._modeSource();
  }

  _clampMode() {
    const count = this._modeCount();
    if (this._activeMode < 1 || this._activeMode > count) {
      this._activeMode = Math.min(Math.max(Number(this._remote.current_mode) || 1, 1), count);
    }
  }

  _binding(modeKey, action) {
    const bindings = this._remote && this._remote.bindings;
    if (!bindings || typeof bindings !== "object") return null;
    const slots = bindings[modeKey];
    if (!slots || typeof slots !== "object") return null;
    const binding = slots[action];
    return binding && Array.isArray(binding.sequence) && binding.sequence.length ? binding : null;
  }

  _emitChanged() {
    this.dispatchEvent(new CustomEvent("changed", { bubbles: true, composed: true }));
  }

  /**
   * Open the guide. The shell owns the router, so the editor navigates the same
   * way it does: push the path and let the frontend router pick it up.
   */
  _openGuide(anchor) {
    const first = window.location.pathname.split("/").filter(Boolean)[0];
    const prefix = first ? `/${first}` : "";
    const target = `${prefix}/guide${anchor ? `#${anchor}` : ""}`;
    window.history.pushState(null, "", target);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  _setStatus(message, kind = "info") {
    if (!this._status) return;
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }
    if (!message) {
      this._status.hidden = true;
      this._status.textContent = "";
      return;
    }
    this._status.className = `editor-status ${kind}`;
    this._status.textContent = message;
    this._status.hidden = false;
    if (kind !== "error") {
      this._statusTimer = setTimeout(() => {
        this._status.hidden = true;
        this._statusTimer = null;
      }, 4000);
    }
  }

  /** Optimistic settings patch: apply locally, then send, roll back on error. */
  async _patch(changes, { render = true } = {}) {
    const remote = this._remote;
    if (!remote || this._busy) return false;
    const previous = {};
    for (const key of Object.keys(changes)) previous[key] = remote[key];

    Object.assign(remote, changes);
    this._clampMode();
    this._signature = JSON.stringify(remote);
    if (render) this._render();

    this._busy = true;
    try {
      await updateRemote(this._hass, remote.subentry_id, changes);
      this._setStatus("Saved.", "success");
      this._emitChanged();
      return true;
    } catch (err) {
      Object.assign(remote, previous);
      this._signature = JSON.stringify(remote);
      if (render) this._render();
      this._setStatus(describeError(err), "error");
      return false;
    } finally {
      this._busy = false;
    }
  }

  /* ------------------------------------------------------------- render -- */

  _render() {
    if (!this._remote) return;
    this._clampMode();
    this._slotRows = new Map();
    this._tabButtons = [];
    this._heroSvg = null;
    this._heroLeds = null;
    this._currentChip = null;

    const body = this._body;
    body.textContent = "";
    body.append(this._buildHead());
    body.append(this._buildModes());
    if (this._isModeless()) body.append(this._buildModeless());
    body.append(this._buildModeSource());
    body.append(this._buildSettings());
    body.append(this._buildDanger());
    this._applyCurrentMode();
    this._restoreFocus();
  }

  /** A control that caused a re-render keeps the keyboard focus. */
  _restoreFocus() {
    const selector = this._focusSelector;
    this._focusSelector = "";
    if (!selector) return;
    const target = this.shadowRoot.querySelector(selector);
    if (target) target.focus();
  }

  /* --------------------------------------------------------------- head -- */

  _buildHead() {
    const remote = this._remote;
    const hero = h("div", { class: "hero" });
    this._fillHero(hero, remote.color);

    const nameInput = h("input", {
      type: "text",
      class: "title-input",
      value: remote.name || "",
      "aria-label": "Name of this remote",
      spellcheck: "false",
      onchange: (event) => this._commitName(event.target),
      onkeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.target.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.target.value = this._remote.name || "";
          event.target.blur();
        }
      },
    });

    const chips = h("div", { class: "row wrap head-chips" });
    this._currentChip = h("span", { text: "" });
    chips.append(h("span", { class: "chip" }, icon("wheel"), this._currentChip));
    if (remote.available === false) {
      chips.append(
        h("span", { class: "chip error" }, icon("cloudOff"), h("span", { text: "Offline in Zigbee2MQTT" }))
      );
    }

    return h(
      "section",
      { class: "card pad-lg head" },
      hero,
      h(
        "div",
        { class: "head-body" },
        nameInput,
        h("p", { class: "head-meta mono", text: `${remote.ieee || ""} · ${MODEL_LABEL}` }),
        chips,
        this._buildSwatches()
      )
    );
  }

  _buildSwatches() {
    const remote = this._remote;
    const colors = (this._config && Array.isArray(this._config.colors) ? this._config.colors : DEFAULT_COLORS)
      .filter((color) => typeof color === "string");
    const activeIndex = colors.indexOf(remote.color);

    const swatches = h("div", {
      class: "swatches",
      role: "radiogroup",
      "aria-label": "Housing colour",
      onkeydown: (event) => this._swatchKeydown(event, colors),
    });

    colors.forEach((color, index) => {
      const active = color === remote.color;
      const tone = housingColor(color);
      const label = colorLabel(color);
      swatches.append(
        h(
          "button",
          {
            type: "button",
            class: `swatch${active ? " is-active" : ""}`,
            role: "radio",
            "aria-checked": active ? "true" : "false",
            "aria-label": `Housing colour ${label}`,
            title: label,
            tabindex: (activeIndex < 0 ? index === 0 : active) ? "0" : "-1",
            "data-color": color,
            onclick: () => {
              if (color !== this._remote.color) {
                this._focusSelector = `.swatch[data-color="${color}"]`;
                this._patch({ color });
              }
            },
          },
          // Inline background instead of a custom property or a pseudo element:
          // this is the one path that cannot be lost on the way to the CSSOM.
          h("span", {
            class: "swatch-dot",
            "aria-hidden": "true",
            style: { backgroundColor: tone || "var(--bil-text-dim)" },
          }),
          active
            ? h("span", {
                class: "swatch-check",
                "aria-hidden": "true",
                style: { color: readableInk(tone) },
                html: `<svg viewBox="0 0 24 24"><path d="${ICONS.check}"/></svg>`,
              })
            : null
        )
      );
    });

    return h(
      "div",
      { class: "swatch-row" },
      h("span", { class: "swatch-label", text: "Housing colour" }),
      swatches,
      h("span", { class: "swatch-current muted small", text: colorLabel(remote.color) })
    );
  }

  _swatchKeydown(event, colors) {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const current = colors.indexOf(this._remote.color);
    const index = current < 0 ? 0 : current;
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % colors.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (index - 1 + colors.length) % colors.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = colors.length - 1;
    const color = colors[next];
    if (color && color !== this._remote.color) {
      this._focusSelector = `.swatch[data-color="${color}"]`;
      this._patch({ color });
    }
  }

  /**
   * Draw the illustration. The <img> plus an LED overlay renders immediately
   * and is always correct; the inlined SVG replaces it as soon as it arrives,
   * because only then the remote's own glow styling can be used.
   */
  _fillHero(host, color) {
    const token = ++this._heroToken;
    const safe = DEFAULT_COLORS.includes(color) ? color : "beige";

    host.textContent = "";
    const wrap = h("div", { class: "hero-fallback" });
    wrap.append(
      h("img", {
        src: imageUrl(safe),
        alt: `IKEA BILRESA remote, ${colorLabel(safe)}`,
        draggable: "false",
      })
    );
    const overlay = h("span", { class: "led-overlay", "aria-hidden": "true" });
    const dots = [];
    for (let i = 0; i < 3; i += 1) {
      const dot = h("i", { style: { left: `${LED_LEFT[i]}%` } });
      dots.push(dot);
      overlay.append(dot);
    }
    wrap.append(overlay);
    host.append(wrap);
    this._heroSvg = null;
    this._heroLeds = dots;
    this._applyCurrentMode();

    loadIllustration(safe)
      .then((markup) => {
        // A newer render (or another colour) already owns the hero.
        if (token !== this._heroToken) return;
        const svg = parseSvg(markup);
        if (!svg) return;
        svg.setAttribute("focusable", "false");
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        host.textContent = "";
        host.append(svg);
        this._heroSvg = svg;
        this._heroLeds = null;
        this._applyCurrentMode();
      })
      .catch(() => {
        // The <img> is already on screen, so there is nothing to fall back to.
      });
  }

  async _commitName(input) {
    const name = String(input.value || "").trim();
    if (!name) {
      input.value = this._remote.name || "";
      this._setStatus("The name cannot be empty.", "error");
      return;
    }
    if (name === this._remote.name) return;
    await this._patch({ name }, { render: false });
    input.value = this._remote.name || "";
  }

  /* -------------------------------------------------------------- modes -- */

  _buildModes() {
    const remote = this._remote;
    const count = this._modeCount();
    const tablist = h("div", {
      class: "tabs",
      role: "tablist",
      "aria-label": "Modes",
      onkeydown: (event) => this._tabKeydown(event),
    });

    for (let mode = 1; mode <= count; mode += 1) {
      if (this._renamingMode === mode) {
        tablist.append(this._buildRenameField(mode));
        continue;
      }
      const selected = mode === this._activeMode;
      const name = modeNameOf(remote, mode);
      const tab = h(
        "button",
        {
          type: "button",
          class: `tab${selected ? " is-selected" : ""}`,
          role: "tab",
          id: `${this._uid}-tab-${mode}`,
          "aria-controls": `${this._uid}-panel`,
          "aria-selected": selected ? "true" : "false",
          tabindex: selected ? "0" : "-1",
          "data-mode": String(mode),
          "aria-label": `${modeLabel(remote, mode)}${
            Number(remote.current_mode) === mode ? " — active on the device" : ""
          }. Press F2 to rename.`,
          onclick: () => this._selectMode(mode),
          ondblclick: () => this._startRename(mode),
        },
        h("span", { class: "tab-index", text: String(mode) }),
        h("span", { class: "tab-name", text: name || `Mode ${mode}` }),
        h("span", { class: "tab-live", hidden: true, "aria-hidden": "true" })
      );
      this._tabButtons.push(tab);
      tablist.append(tab);
    }

    const renameBtn = h(
      "button",
      {
        type: "button",
        class: "icon-btn",
        "aria-label": `Rename mode ${this._activeMode}`,
        title: "Rename this mode",
        onclick: () => this._startRename(this._activeMode),
      },
      icon("pencil")
    );

    const panel = h("div", {
      class: "tabpanel",
      role: "tabpanel",
      id: `${this._uid}-panel`,
      "aria-labelledby": `${this._uid}-tab-${this._activeMode}`,
      tabindex: "0",
    });
    panel.append(this._buildSlotList());

    return h(
      "section",
      { class: "card pad-lg modes" },
      h(
        "div",
        { class: "section-head tight" },
        h(
          "div",
          null,
          h("h2", { text: "Modes" }),
          h("p", {
            text:
              "Every mode is one channel of the remote with its own actions. Double-click a tab to rename it.",
          })
        ),
        h("div", { class: "spacer" }),
        renameBtn
      ),
      h("div", { class: "tabs-scroll" }, tablist),
      panel
    );
  }

  _buildRenameField(mode) {
    const input = h("input", {
      type: "text",
      class: "tab-rename",
      value: modeNameOf(this._remote, mode),
      "aria-label": `Name of mode ${mode}`,
      placeholder: `Mode ${mode}`,
      spellcheck: "false",
      onkeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this._commitRename(mode, event.target.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          this._renamingMode = 0;
          this._render();
        }
      },
      onblur: (event) => {
        if (this._renamingMode === mode) this._commitRename(mode, event.target.value);
      },
    });
    // Focus once the fresh DOM is in place.
    requestAnimationFrame(() => {
      if (input.isConnected) {
        input.focus();
        input.select();
      }
    });
    return input;
  }

  _startRename(mode) {
    this._activeMode = mode;
    this._renamingMode = mode;
    this._render();
  }

  async _commitRename(mode, rawValue) {
    if (this._renamingMode !== mode) return;
    this._renamingMode = 0;
    const value = String(rawValue || "").trim();
    const names = [];
    const count = this._modeCount();
    for (let i = 1; i <= count; i += 1) names.push(modeNameOf(this._remote, i));
    names[mode - 1] = value || `Mode ${mode}`;
    if (names[mode - 1] === modeNameOf(this._remote, mode)) {
      this._render();
      return;
    }
    await this._patch({ mode_names: names });
  }

  _selectMode(mode) {
    if (mode === this._activeMode) {
      this._startRename(mode);
      return;
    }
    this._activeMode = mode;
    this._renamingMode = 0;
    this._render();
    const tab = this._tabButtons.find((item) => Number(item.dataset.mode) === mode);
    if (tab) tab.focus();
  }

  _tabKeydown(event) {
    const count = this._modeCount();
    const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End", "F2"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    if (event.key === "F2") {
      this._startRename(this._activeMode);
      return;
    }
    let next = this._activeMode;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (this._activeMode % count) + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = ((this._activeMode - 2 + count) % count) + 1;
    else if (event.key === "Home") next = 1;
    else if (event.key === "End") next = count;
    if (next === this._activeMode) return;
    this._activeMode = next;
    this._renamingMode = 0;
    this._render();
    const tab = this._tabButtons.find((item) => Number(item.dataset.mode) === next);
    if (tab) tab.focus();
  }

  /* -------------------------------------------------------------- slots -- */

  _buildSlotList() {
    const remote = this._remote;
    const mode = this._activeMode;
    const modeKey = String(mode);
    const list = h("div", { class: "slots" });

    const actions = [];
    if (remote.split_single_click === true) actions.push("click_on", "click_off");
    else actions.push("click");
    actions.push("wheel");
    if (!this._isModeless()) actions.push("double", "triple");

    for (const action of actions) list.append(this._buildSlotRow(modeKey, action));

    if (remote.split_single_click === true) {
      list.append(
        h("p", {
          class: "slot-note muted small",
          text:
            `A single click alternates between “on” and “off” inside the remote. With ` +
            `“${actionTitle("click_on")}” and “${actionTitle("click_off")}” bound separately, ` +
            `which slot runs depends on that internal state.`,
        })
      );
    }
    return list;
  }

  _buildSlotRow(modeKey, action) {
    const binding = this._binding(modeKey, action);
    const summary = binding ? describeSequence(binding.sequence, this._hass) : "";
    const label = actionTitle(action);
    const scope = modeKey === MODELESS_KEY ? "for all modes" : `in ${modeLabel(this._remote, Number(modeKey))}`;

    const row = h("div", {
      class: `slot${binding ? "" : " is-empty"}`,
      "data-slot": `${modeKey}:${action}`,
    });

    const main = h(
      "div",
      { class: "slot-main" },
      h(
        "div",
        { class: "slot-title" },
        h("span", { text: label }),
        binding && binding.script_mode && binding.script_mode !== "single"
          ? h("span", {
              class: "chip neutral tiny",
              text: SCRIPT_MODE_LABELS[binding.script_mode] || binding.script_mode,
            })
          : null
      ),
      h("p", { class: "slot-sub muted small", text: SLOT_HINTS[action] || "" }),
      binding
        ? h("p", { class: "slot-summary", title: summary, text: summary })
        : h("p", { class: "slot-summary empty", text: "Nothing stored yet" })
    );

    const editBtn = h(
      "button",
      {
        type: "button",
        class: "btn small primary",
        "aria-label": `Edit ${label} ${scope}`,
        onclick: () => this._openDialog(modeKey, action),
      },
      icon("pencil"),
      h("span", { text: binding ? "Edit" : "Assign" })
    );

    const testBtn = h(
      "button",
      {
        type: "button",
        class: "btn small",
        disabled: !binding,
        title: binding ? "Run this action once" : "Assign an action first",
        "aria-label": `Test ${label} ${scope}`,
        onclick: (event) => this._test(modeKey, action, event.currentTarget),
      },
      icon("play"),
      h("span", { text: "Test" })
    );

    const clearBtn = h(
      "button",
      {
        type: "button",
        class: "btn small danger",
        disabled: !binding,
        "aria-label": `Clear ${label} ${scope}`,
        onclick: (event) => this._armClear(event.currentTarget, modeKey, action, label),
      },
      icon("trash"),
      h("span", { text: "Clear" })
    );

    row.append(
      icon(SLOT_ICONS[action] || "tap", "slot-icon"),
      main,
      h("div", { class: "slot-actions" }, editBtn, testBtn, clearBtn)
    );

    this._slotRows.set(`${modeKey}:${action}`, row);
    return row;
  }

  async _test(modeKey, action, button) {
    if (!button) return;
    button.disabled = true;
    try {
      await testBinding(this._hass, this._remote.subentry_id, modeKey, action);
      this._setStatus(`“${actionTitle(action)}” ran once.`, "success");
    } catch (err) {
      this._setStatus(describeError(err), "error");
    } finally {
      button.disabled = false;
    }
  }

  _armClear(button, modeKey, action, label) {
    if (button.dataset.armed === "1") {
      button.dataset.armed = "0";
      this._clear(modeKey, action, label, button);
      return;
    }
    button.dataset.armed = "1";
    button.textContent = "";
    button.append(icon("alert"), h("span", { text: "Really?" }));
    setTimeout(() => {
      if (!button.isConnected || button.dataset.armed !== "1") return;
      button.dataset.armed = "0";
      button.textContent = "";
      button.append(icon("trash"), h("span", { text: "Clear" }));
    }, 4000);
  }

  async _clear(modeKey, action, label, button) {
    button.disabled = true;
    try {
      await clearBinding(this._hass, this._remote.subentry_id, modeKey, action);
      const bindings = this._remote.bindings;
      if (bindings && bindings[modeKey]) {
        delete bindings[modeKey][action];
        if (!Object.keys(bindings[modeKey]).length) delete bindings[modeKey];
      }
      this._signature = JSON.stringify(this._remote);
      this._setStatus(`“${label}” is empty now.`, "success");
      this._render();
      this._emitChanged();
    } catch (err) {
      button.disabled = false;
      this._setStatus(describeError(err), "error");
    }
  }

  /* ----------------------------------------------------------- modeless -- */

  _buildModeless() {
    const groups = groupIdsOf(this._remote);
    const list = h("div", { class: "slots" });
    for (const action of ["double", "triple"]) {
      list.append(this._buildSlotRow(MODELESS_KEY, action));
      const leftovers = this._leftoverModes(action);
      if (leftovers.length) {
        list.append(
          h("p", {
            class: "slot-note muted small",
            text: `“${actionTitle(action)}” also has something stored in ${leftovers
              .map((mode) => modeLabel(this._remote, mode))
              .join(", ")}. That only runs while this slot here is empty.`,
          })
        );
      }
    }

    return h(
      "section",
      { class: "card pad-lg modeless" },
      h(
        "div",
        { class: "section-head tight" },
        h(
          "div",
          null,
          h("h2", { text: "Shared by all modes" }),
          h("p", { text: "Double and triple click apply no matter which mode is selected." })
        )
      ),
      h(
        "div",
        { class: "notice warning explain" },
        icon("info"),
        h(
          "div",
          null,
          h("strong", { text: "Why is this not per mode?" }),
          h("p", {
            text:
              `A single click and a wheel turn arrive as a groupcast: the frame carries an ` +
              `action_group, the group id of the selected channel (${groups.join(", ")}), and that ` +
              `is how Home Assistant recognises the mode. A double or triple click is sent as a ` +
              `unicast instead, entirely without an action_group — the payload simply holds ` +
              `nothing the channel could be derived from.`,
          }),
          h("p", {
            text:
              "That is why these two actions live here once for the whole remote. To bind them " +
              "per mode anyway, switch “Mode-independent multiclicks” off further down — the last " +
              "known mode is used then, which can be wrong for one press after a channel change.",
          })
        )
      ),
      list
    );
  }

  _leftoverModes(action) {
    const bindings = this._remote.bindings;
    if (!bindings || typeof bindings !== "object") return [];
    const modes = [];
    for (let mode = 1; mode <= this._modeCount(); mode += 1) {
      if (this._binding(String(mode), action)) modes.push(mode);
    }
    return modes;
  }

  /* -------------------------------------------------------- mode source -- */

  _buildModeSource() {
    const remote = this._remote;
    const groups = groupIdsOf(remote);
    const selected = this._modeSource();
    const effective = this._effectiveSource();
    const sources =
      this._config && Array.isArray(this._config.mode_sources) && this._config.mode_sources.length
        ? this._config.mode_sources
        : DEFAULT_MODE_SOURCES;
    // Hybrid first: it is the default and the answer for anyone who is unsure.
    const ordered = DEFAULT_MODE_SOURCES.filter((source) => sources.includes(source)).concat(
      sources.filter((source) => !DEFAULT_MODE_SOURCES.includes(source))
    );

    const section = h("section", { class: "card pad-lg source" });

    section.append(
      h(
        "div",
        { class: "section-head tight" },
        h(
          "div",
          null,
          h("h2", { text: "Where the mode comes from" }),
          h("p", {
            text:
              "The remote has three internal channels; the lower button switches them and the LED " +
              "shows the active one. The only open question is how Home Assistant learns which " +
              "one is on.",
          })
        ),
        h("div", { class: "spacer" }),
        h(
          "button",
          {
            type: "button",
            class: "btn small",
            onclick: () => this._openGuide("sec-unlock"),
          },
          icon("help"),
          h("span", { text: "How do I unlock the channels?" })
        )
      )
    );

    if (effective && effective !== selected) {
      section.append(
        h(
          "div",
          { class: "notice source-live" },
          icon("info"),
          h(
            "div",
            null,
            h("strong", { text: `Currently using: ${modeSourceTitle(effective)}` }),
            h("p", {
              text:
                effective === "device"
                  ? "The remote's channels were detected, so the mode now comes straight from the " +
                    "radio traffic. Hybrid switched over on its own and stays there."
                  : `The setting says ${modeSourceTitle(selected)}, but ${modeSourceTitle(
                      effective
                    )} is what drives the mode right now.`,
            })
          )
        )
      );
    }

    const group = h("div", {
      class: "source-options",
      role: "radiogroup",
      "aria-label": "Where the mode comes from",
    });
    for (const source of ordered) group.append(this._buildSourceOption(source, selected, effective, groups));
    section.append(group);

    return section;
  }

  _buildSourceOption(source, selected, effective, groups) {
    const id = `${this._uid}-source-${source}`;
    const active = source === selected;
    const texts = {
      device: {
        summary:
          `Home Assistant reads the channel out of the radio traffic: a single click and the ` +
          `wheel are addressed to a group id (${groups.join(", ")}), and that id names the channel.`,
        audience: "For remotes whose three channels were unlocked with Touchlink.",
        iconName: "antenna",
      },
      internal: {
        summary:
          "The mode does not come from the remote at all. Home Assistant counts it up itself " +
          "whenever the action picked below is triggered.",
        audience: "For everyone who did not run the Touchlink procedure. The lower button has no effect.",
        iconName: "cycle",
      },
      hybrid: {
        summary:
          "Starts out like Internal and switches over to Device on its own, the first time a " +
          "second group id shows up.",
        audience: "The default. Pick this if you are not sure.",
        iconName: "swap",
      },
    };
    const text = texts[source] || {
      summary: "",
      audience: "",
      iconName: "info",
    };

    const option = h("div", { class: `source-option${active ? " is-active" : ""}` });

    const input = h("input", {
      type: "radio",
      id,
      name: `${this._uid}-source`,
      value: source,
      checked: active,
      onchange: (event) => {
        if (!event.target.checked) return;
        this._focusSelector = `#${id}`;
        this._patch({ mode_source: source });
      },
    });

    const label = h(
      "label",
      { class: "source-label", for: id },
      input,
      h(
        "span",
        { class: "source-body" },
        h(
          "span",
          { class: "source-title" },
          icon(text.iconName, "source-icon"),
          h("span", { text: modeSourceTitle(source) }),
          source === "hybrid" ? h("span", { class: "chip neutral tiny", text: "default" }) : null,
          active && effective === source
            ? h("span", { class: "chip success tiny", text: "in use" })
            : null,
          active && effective !== source
            ? h("span", { class: "chip warning tiny", text: `now: ${modeSourceTitle(effective)}` })
            : null
        ),
        h("span", { class: "source-text", text: text.summary }),
        h("span", { class: "source-for", text: text.audience })
      )
    );

    option.append(label);
    if (active) {
      const extra = this._buildSourceExtra(source, effective);
      if (extra) option.append(extra);
    }
    return option;
  }

  /** What the chosen source still needs — shown right next to the option. */
  _buildSourceExtra(source, effective) {
    // Hybrid that has already promoted itself behaves exactly like Device.
    const usesDevice = source === "device" || (source === "hybrid" && effective === "device");
    const wrap = h("div", { class: "source-extra" });

    if (usesDevice) {
      wrap.append(
        h(
          "div",
          { class: "source-note" },
          icon("check"),
          h(
            "div",
            null,
            h("strong", { text: "Nothing to set up" }),
            h("p", {
              class: "muted small",
              text:
                "The lower button switches the channel in the hardware itself and sends nothing " +
                "over the air. The new channel shows up with the next click or wheel turn.",
            })
          )
        )
      );
      return wrap;
    }

    const remote = this._remote;
    const actions =
      this._config && Array.isArray(this._config.actions) && this._config.actions.length
        ? this._config.actions
        : DEFAULT_ACTIONS;

    if (source === "hybrid") {
      wrap.append(
        h("p", {
          class: "hint",
          text:
            "No second group id has shown up yet, so Hybrid behaves exactly like Internal: the " +
            "action below advances the mode.",
        })
      );
    }

    const grid = h("div", { class: "form-grid" });
    grid.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `${this._uid}-cycle`, text: "Action that advances the mode" }),
        h(
          "select",
          {
            id: `${this._uid}-cycle`,
            onchange: (event) => {
              this._focusSelector = `#${this._uid}-cycle`;
              this._patch({ mode_cycle_action: event.target.value });
            },
          },
          actions.map((action) =>
            h(
              "option",
              { value: action, selected: action === remote.mode_cycle_action },
              actionTitle(action)
            )
          )
        ),
        h("span", {
          class: "hint",
          text: "This action counts the mode up. A script stored for it still runs as well.",
        })
      )
    );
    grid.append(
      this._switchField(
        `${this._uid}-wrap`,
        "Start over at mode 1 after the last one",
        "Off: it stops at the last mode.",
        remote.cycle_wrap !== false,
        (checked) => {
          this._focusSelector = `#${this._uid}-wrap`;
          this._patch({ cycle_wrap: checked });
        }
      )
    );
    wrap.append(grid);
    return wrap;
  }

  /* ----------------------------------------------------------- settings -- */

  _buildSettings() {
    const remote = this._remote;
    const details = h("details", {
      class: "card settings",
      open: this._settingsOpen,
      ontoggle: (event) => {
        this._settingsOpen = event.target.open;
      },
    });

    details.append(
      h(
        "summary",
        { class: "settings-summary" },
        icon("cog"),
        h("span", { text: "Advanced settings" }),
        h("span", {
          class: "muted small",
          text: "Number of modes, wheel throttle, group ids",
        })
      )
    );

    const grid = h("div", { class: "settings-grid" });

    grid.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `${this._uid}-count`, text: "Number of modes" }),
        h("input", {
          type: "number",
          id: `${this._uid}-count`,
          min: "1",
          max: String(MAX_MODE_COUNT),
          step: "1",
          value: String(this._modeCount()),
          onchange: (event) => this._commitModeCount(event.target),
        }),
        h("span", {
          class: "hint",
          text: "The housing has three channels. More modes only make sense with internal switching.",
        })
      )
    );

    grid.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `${this._uid}-throttle`, text: "Wheel throttle (ms)" }),
        h("input", {
          type: "number",
          id: `${this._uid}-throttle`,
          min: "0",
          max: "10000",
          step: "10",
          value: String(Number(remote.wheel_throttle_ms) || 0),
          onchange: (event) => this._commitThrottle(event.target),
        }),
        h("span", {
          class: "hint",
          text: "A turn produces a burst of values. This is how long the next run waits; the last value still arrives.",
        })
      )
    );

    grid.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `${this._uid}-groups`, text: "Group ids" }),
        h("input", {
          type: "text",
          id: `${this._uid}-groups`,
          class: "mono",
          inputmode: "numeric",
          spellcheck: "false",
          value: (Array.isArray(remote.group_ids) ? remote.group_ids : []).join(", "),
          onchange: (event) => this._commitGroups(event.target),
        }),
        h("span", {
          class: "hint",
          text: "The Zigbee2MQTT groups of the channels, in the order mode 1, 2, 3. Only used by Device and Hybrid.",
        })
      )
    );

    const switches = h("div", { class: "settings-switches" });
    switches.append(
      this._switchField(
        `${this._uid}-modeless`,
        "Mode-independent multiclicks",
        "Double and triple click count once for the whole remote. Off: they follow the last known mode.",
        remote.modeless_multiclick !== false,
        (checked) => this._patch({ modeless_multiclick: checked })
      )
    );
    switches.append(
      this._switchField(
        `${this._uid}-split`,
        "Split the single click",
        "Separate slots for the “on” and the “off” phase of the wheel instead of one shared click slot.",
        remote.split_single_click === true,
        (checked) => this._patch({ split_single_click: checked })
      )
    );

    details.append(h("div", { class: "settings-body" }, grid, switches));
    return details;
  }

  _switchField(id, label, hint, checked, onChange) {
    const input = h("input", {
      type: "checkbox",
      id,
      checked,
      onchange: (event) => onChange(event.target.checked),
    });
    return h(
      "div",
      { class: "switch-field" },
      h("label", { class: "switch", for: id }, input, h("span", { class: "switch-track" })),
      h(
        "div",
        { class: "switch-text" },
        h("label", { class: "switch-label", for: id, text: label }),
        h("span", { class: "hint", text: hint })
      )
    );
  }

  _commitModeCount(input) {
    const value = Math.round(Number(input.value));
    if (!Number.isFinite(value) || value < 1 || value > MAX_MODE_COUNT) {
      input.value = String(this._modeCount());
      this._setStatus(`The number of modes has to be between 1 and ${MAX_MODE_COUNT}.`, "error");
      return;
    }
    if (value === this._modeCount()) return;
    const names = [];
    for (let i = 1; i <= value; i += 1) names.push(modeNameOf(this._remote, i) || `Mode ${i}`);
    this._patch({ mode_count: value, mode_names: names });
  }

  _commitThrottle(input) {
    const value = Math.round(Number(input.value));
    const current = Number(this._remote.wheel_throttle_ms) || 0;
    if (!Number.isFinite(value) || value < 0 || value > 10000) {
      input.value = String(current);
      this._setStatus("The wheel throttle has to be between 0 and 10000 ms.", "error");
      return;
    }
    if (value === current) return;
    this._patch({ wheel_throttle_ms: value }, { render: false });
  }

  _commitGroups(input) {
    const current = Array.isArray(this._remote.group_ids) ? this._remote.group_ids : [];
    const parts = String(input.value || "")
      .split(/[\s,;]+/)
      .filter(Boolean);
    const ids = [];
    for (const part of parts) {
      const value = Number(part);
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        input.value = current.join(", ");
        this._setStatus(`“${part}” is not a valid group id (0 to 65535).`, "error");
        return;
      }
      ids.push(value);
    }
    if (!ids.length) {
      input.value = current.join(", ");
      this._setStatus("At least one group id is needed.", "error");
      return;
    }
    if (ids.length === current.length && ids.every((id, index) => id === current[index])) return;
    this._patch({ group_ids: ids }, { render: false });
  }

  /* ------------------------------------------------------------- delete -- */

  _buildDanger() {
    const section = h("section", { class: "card danger" });
    const bindingCount = this._countBindings();

    section.append(
      h(
        "div",
        { class: "danger-text" },
        h("h2", { text: "Remove this remote" }),
        h("p", {
          class: "muted small",
          text: `Deletes this remote together with ${
            bindingCount === 1 ? "one stored action" : `${bindingCount} stored actions`
          }. The device itself stays in Zigbee2MQTT and can be set up again at any time.`,
        })
      )
    );

    if (!this._confirmDelete) {
      section.append(
        h(
          "button",
          {
            type: "button",
            class: "btn danger",
            onclick: () => {
              this._confirmDelete = true;
              this._render();
              const btn = this.shadowRoot.querySelector(".danger .confirm-yes");
              if (btn) btn.focus();
            },
          },
          icon("trash"),
          h("span", { text: "Delete" })
        )
      );
      return section;
    }

    section.append(
      h(
        "div",
        { class: "confirm row wrap", role: "group", "aria-label": "Confirm deletion" },
        h("span", {
          class: "confirm-text",
          text: `Really delete “${this._remote.name || this._remote.ieee}”?`,
        }),
        h(
          "button",
          {
            type: "button",
            class: "btn danger confirm-yes",
            onclick: (event) => this._delete(event.currentTarget),
          },
          icon("trash"),
          h("span", { text: "Yes, delete it" })
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn ghost",
            onclick: () => {
              this._confirmDelete = false;
              this._render();
            },
          },
          h("span", { text: "Cancel" })
        )
      )
    );
    return section;
  }

  _countBindings() {
    const bindings = this._remote.bindings;
    if (!bindings || typeof bindings !== "object") return 0;
    let count = 0;
    for (const slots of Object.values(bindings)) {
      if (slots && typeof slots === "object") count += Object.keys(slots).length;
    }
    return count;
  }

  async _delete(button) {
    button.disabled = true;
    try {
      await deleteRemote(this._hass, this._remote.subentry_id);
      this._confirmDelete = false;
      this._emitChanged();
    } catch (err) {
      button.disabled = false;
      this._setStatus(describeError(err), "error");
    }
  }

  /* ------------------------------------------------------------- dialog -- */

  _openDialog(modeKey, action) {
    this._closeDialog();
    const binding = this._binding(modeKey, action);
    const dialog = document.createElement("bilresa-action-editor");
    dialog.hass = this._hass;
    dialog.subentryId = this._remote.subentry_id;
    dialog.modeKey = modeKey;
    dialog.action = action;
    dialog.context =
      modeKey === MODELESS_KEY
        ? `${this._remote.name || this._remote.ieee} · all modes`
        : `${this._remote.name || this._remote.ieee} · ${modeLabel(this._remote, Number(modeKey))}`;
    dialog.binding = binding ? { sequence: binding.sequence, script_mode: binding.script_mode } : null;

    dialog.addEventListener("saved", () => {
      this._setStatus(`“${actionTitle(action)}” saved.`, "success");
      this._emitChanged();
    });
    dialog.addEventListener("dialog-closed", () => this._closeDialog());

    this._dialog = dialog;
    this.shadowRoot.append(dialog);
  }

  _closeDialog() {
    const dialog = this._dialog;
    this._dialog = null;
    if (dialog && dialog.parentNode) dialog.remove();
  }
}

/* ------------------------------------------------------------------ styles -- */

const EDITOR_STYLES = `
:host { display: block; background: transparent; min-height: 0; }

.editor { display: flex; flex-direction: column; gap: var(--bil-gap); }

.editor-status {
  margin: 0 0 var(--bil-gap);
  padding: 10px 14px;
  border-radius: var(--bil-radius-md);
  border-left: 3px solid var(--bil-accent);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-accent) 10%, var(--bil-surface));
  font-size: var(--bil-font-sm);
}

.editor-status.success {
  border-left-color: var(--bil-success);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-success) 12%, var(--bil-surface));
}

.editor-status.error {
  border-left-color: var(--bil-error);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-error) 12%, var(--bil-surface));
}

.section-head.tight { margin-bottom: var(--bil-space-2); align-items: center; }

/* ----------------------------------------------------------------- head -- */

.head { display: flex; gap: var(--bil-gap-lg); align-items: flex-start; }

.hero { flex: none; width: 116px; }
.hero svg { width: 100%; height: auto; display: block; }
.hero-fallback { position: relative; width: 100%; aspect-ratio: 200 / 330; }
.hero-fallback img { width: 100%; height: 100%; object-fit: contain; display: block; }

/* The LED row sits at cy 216 of the 330 unit tall illustration (65.45%), the
   three LEDs at cx 82/100/118 of 200 — that is where the overlay dots have to
   land while the <img> is on screen. */
.hero-fallback .led-overlay { position: absolute; inset: 0; pointer-events: none; }
.hero-fallback .led-overlay i {
  position: absolute;
  top: 65.45%;
  width: 6%;
  aspect-ratio: 1;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: rgba(42, 42, 42, 0.55);
}
.hero-fallback .led-overlay i.on {
  background: var(--bil-led-on);
  box-shadow: 0 0 5px 2px rgba(255, 243, 208, 0.7);
}

.head-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--bil-space-3); }

.title-input {
  font-size: var(--bil-font-2xl);
  font-weight: 700;
  padding: var(--bil-space-2) var(--bil-space-3);
  border-color: transparent;
  background: transparent;
  min-height: 48px;
}

.title-input:hover { border-color: var(--bil-line); }
.title-input:focus { border-color: var(--bil-accent); background: var(--bil-surface); }

.head-meta { margin: 0; font-size: var(--bil-font-xs); color: var(--bil-text-dim); overflow-wrap: anywhere; }
.head-chips { gap: var(--bil-space-2); }

.swatch-row { display: flex; align-items: center; gap: var(--bil-space-3); flex-wrap: wrap; }

.swatch-label {
  font-size: var(--bil-font-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--bil-text-dim);
}

.swatches { display: flex; align-items: center; gap: var(--bil-space-1); }

.swatch {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--bil-control);
  height: var(--bil-control);
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}

/* Older revisions painted the housing colour into a pseudo element fed by a
   custom property. The colour now comes from .swatch-dot, so any leftover
   pseudo element rule must not generate a box on top of it. */
.swatch::before, .swatch::after { content: none; }

.swatch-dot {
  display: block;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
  transition: width 0.15s ease, height 0.15s ease;
}

.swatch:hover .swatch-dot { width: 30px; height: 30px; }

.swatch-check {
  position: absolute;
  display: block;
  width: 16px;
  height: 16px;
  pointer-events: none;
}

.swatch-check svg { width: 100%; height: 100%; display: block; fill: currentColor; }

.swatch.is-active { border-color: var(--bil-accent); }
.swatch.is-active .swatch-dot { width: 30px; height: 30px; }
.swatch-current { text-transform: none; }

/* ----------------------------------------------------------------- tabs -- */

.tabs-scroll { overflow-x: auto; margin: 0 -4px; padding: 0 4px 4px; }

.tabs {
  display: flex;
  gap: var(--bil-space-2);
  border-bottom: var(--bil-border);
  padding-bottom: var(--bil-space-2);
  min-width: min-content;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--bil-space-2);
  min-height: var(--bil-control);
  padding: 0 14px;
  border: var(--bil-border);
  border-radius: var(--bil-pill);
  background: transparent;
  color: var(--bil-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.tab:hover { background: color-mix(in srgb, var(--bil-text) 7%, transparent); }

.tab.is-selected {
  background: var(--bil-accent);
  border-color: transparent;
  color: var(--bil-on-accent);
}

.tab-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  border-radius: var(--bil-pill);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text) 12%, transparent);
  font-size: var(--bil-font-xs);
}

.tab.is-selected .tab-index { background: rgba(255, 255, 255, 0.25); }

.tab-live {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--bil-success);
  box-shadow: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--bil-success) 30%, transparent);
}

.tab.is-current { border-color: var(--bil-success); }
.tab.is-current.is-selected { border-color: transparent; }

.tab-rename {
  min-height: var(--bil-control);
  width: 200px;
  border-radius: var(--bil-pill);
  padding: 0 var(--bil-space-4);
}

.tabpanel { padding-top: var(--bil-gap); }

/* ---------------------------------------------------------------- slots -- */

.slots { display: flex; flex-direction: column; gap: var(--bil-space-3); }

.slot {
  display: flex;
  align-items: center;
  gap: var(--bil-gap);
  padding: var(--bil-space-3) 14px;
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
  background: var(--bil-surface);
  transition: border-color 0.2s ease, background-color 0.4s ease;
}

.slot.is-empty {
  border-style: dashed;
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text) 3%, transparent);
}

.slot.is-hit {
  border-color: var(--bil-accent);
  animation: bil-slot-hit 1.4s ease-out;
}

@keyframes bil-slot-hit {
  0% { background: color-mix(in srgb, var(--bil-accent) 32%, var(--bil-surface)); }
  100% { background: var(--bil-surface); }
}

.slot .slot-icon { width: 28px; height: 28px; color: var(--bil-accent); flex: none; }
.slot.is-empty .slot-icon { color: var(--bil-text-dim); }

.slot-main { flex: 1 1 auto; min-width: 0; }
.slot-title { display: flex; align-items: center; gap: var(--bil-space-2); font-weight: 600; }
.slot-sub { margin: 2px 0 0; }

.slot-summary {
  margin: var(--bil-space-1) 0 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.slot-summary.empty { color: var(--bil-text-dim); font-style: italic; }
.slot-actions { display: flex; align-items: center; gap: var(--bil-space-2); flex: none; flex-wrap: wrap; justify-content: flex-end; }
.slot-note { margin: 0 2px; }

.chip.tiny { font-size: var(--bil-font-2xs); padding: 1px var(--bil-space-2); }

.notice.explain { align-items: flex-start; }
.notice.explain p + p { margin-top: var(--bil-space-2); }

/* ---------------------------------------------------------- mode source -- */

/* One card per row instead of a track: only the selected card carries extra
   controls, and a grid would leave a ragged hole next to it. */
.source-options {
  display: flex;
  flex-direction: column;
  gap: var(--bil-space-3);
}

.source-option {
  display: flex;
  flex-direction: column;
  gap: var(--bil-space-3);
  padding: var(--bil-space-4);
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
  background: var(--bil-surface);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.source-option:hover { border-color: color-mix(in srgb, var(--bil-accent) 45%, var(--bil-line)); }

.source-option.is-active {
  border-color: var(--bil-accent);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-accent) 7%, var(--bil-surface));
}

.source-label {
  display: flex;
  align-items: flex-start;
  gap: var(--bil-space-3);
  min-height: var(--bil-control);
  cursor: pointer;
}

.source-label input {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  width: 20px;
  height: 20px;
  margin: 2px 0 0;
  min-height: 0;
  padding: 0;
  border: 2px solid var(--bil-text-dim);
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.source-label input:checked {
  border-color: var(--bil-accent);
  box-shadow: inset 0 0 0 4px var(--bil-accent);
}

.source-body { display: flex; flex-direction: column; gap: var(--bil-space-1); min-width: 0; }

.source-title {
  display: flex;
  align-items: center;
  gap: var(--bil-space-2);
  flex-wrap: wrap;
  font-size: var(--bil-font-lg);
  font-weight: 600;
  line-height: var(--bil-line-snug);
}

.source-title .source-icon { width: 18px; height: 18px; color: var(--bil-accent); }

.source-text {
  font-size: var(--bil-font-sm);
  line-height: var(--bil-line-normal);
  color: var(--bil-text-dim);
  max-width: 62ch;
}

.source-for {
  font-size: var(--bil-font-xs);
  line-height: var(--bil-line-snug);
  color: var(--bil-text-soft);
  max-width: 62ch;
}

.source-extra {
  display: flex;
  flex-direction: column;
  gap: var(--bil-space-3);
  padding-top: var(--bil-space-3);
  border-top: var(--bil-border);
}

.source-note { display: flex; align-items: flex-start; gap: var(--bil-space-3); }
.source-note .icon { flex: none; margin-top: 1px; color: var(--bil-success); }
.source-note p { margin-top: 2px; max-width: 68ch; }

.notice.source-live {
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-accent) 10%, var(--bil-surface));
  border-left-color: var(--bil-accent);
  margin-bottom: var(--bil-space-4);
}

.notice.source-live .icon { color: var(--bil-accent); }

/* ------------------------------------------------------------- settings -- */

.settings { padding: 0; }

.settings-summary {
  display: flex;
  align-items: center;
  gap: var(--bil-space-3);
  padding: var(--bil-space-4) var(--bil-gap);
  min-height: 56px;
  cursor: pointer;
  font-weight: 600;
  list-style: none;
  border-radius: var(--bil-radius-lg);
}

.settings-summary::-webkit-details-marker { display: none; }
.settings-summary:hover { background: color-mix(in srgb, var(--bil-text) 5%, transparent); }
.settings[open] .settings-summary { border-bottom: var(--bil-border); border-radius: var(--bil-radius-lg) var(--bil-radius-lg) 0 0; }

.settings-body {
  display: flex;
  flex-direction: column;
  gap: var(--bil-gap-lg);
  padding: var(--bil-gap-lg) var(--bil-gap);
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
  gap: var(--bil-gap);
  align-items: start;
}

.settings-switches { display: flex; flex-direction: column; gap: var(--bil-gap); }

.switch-field { display: flex; align-items: flex-start; gap: var(--bil-space-3); }
.switch-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.switch-label { font-weight: 600; cursor: pointer; }

.switch {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  width: 52px;
  height: var(--bil-control);
  cursor: pointer;
}

.switch input {
  position: absolute;
  opacity: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
}

.switch-track {
  position: relative;
  width: 46px;
  height: 26px;
  border-radius: var(--bil-pill);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text) 22%, transparent);
  transition: background-color 0.18s ease;
  pointer-events: none;
}

.switch-track::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bil-surface);
  box-shadow: var(--bil-shadow-1);
  transition: transform 0.18s ease;
}

.switch input:checked + .switch-track { background: var(--bil-accent); }
.switch input:checked + .switch-track::after { transform: translateX(20px); }
.switch input:focus-visible + .switch-track { outline: 2px solid var(--bil-accent); outline-offset: 2px; }

/* --------------------------------------------------------------- danger -- */

.danger {
  display: flex;
  align-items: center;
  gap: var(--bil-gap);
  flex-wrap: wrap;
  border: 1px solid var(--divider-color, rgba(127,127,127,.3)) 35%, transparent);
  border: 1px solid color-mix(in srgb, var(--bil-error) 35%, transparent);
}

.danger-text { flex: 1 1 320px; min-width: 0; }
.danger-text h2 { margin: 0; font-size: var(--bil-font-lg); font-weight: 600; }
.danger-text p { margin: var(--bil-space-1) 0 0; }
.danger .confirm { gap: var(--bil-space-3); }
.danger .confirm-text { font-weight: 600; }

/* ----------------------------------------------------------- responsive -- */

@media (max-width: 700px) {
  .head { flex-direction: row; gap: var(--bil-gap); }
  .hero { width: 76px; }
  .title-input { font-size: var(--bil-font-xl); }
  .slot { flex-wrap: wrap; }
  .slot-main { flex: 1 1 100%; order: 2; }
  .slot .slot-icon { order: 1; }
  .slot-actions { flex: 1 1 100%; order: 3; justify-content: flex-start; }
  .slot-actions .btn { flex: 1 1 auto; }
  .settings-grid { grid-template-columns: 1fr; }
}
`;

if (!customElements.get("bilresa-remote-editor")) {
  customElements.define("bilresa-remote-editor", BilresaRemoteEditor);
}

export { BilresaRemoteEditor, describeSequence, stepSummary };
