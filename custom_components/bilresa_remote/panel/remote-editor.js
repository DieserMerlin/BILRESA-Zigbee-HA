/**
 * <bilresa-remote-editor> — the heart of the panel.
 *
 * One remote, top to bottom: identity (illustration, name, colour), the mode
 * tabs, the bindable slots of the selected mode, the mode independent slots,
 * the settings and finally deletion.
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
  MODELESS_KEY,
  MODE_SOURCE_LABELS,
  clearBinding,
  deleteRemote,
  describeError,
  formatAction,
  subscribeEvents,
  testBinding,
  updateRemote,
} from "./api.js";

const IMAGE_BASE = "/bilresa_remote/images";
const MODEL_LABEL = "IKEA BILRESA E2490";
const MAX_MODE_COUNT = 9;
const DEFAULT_COLORS = ["red", "beige", "green"];
const DEFAULT_MODE_SOURCES = ["hybrid", "device", "internal"];
const DEFAULT_ACTIONS = ["click", "click_on", "click_off", "double", "triple", "wheel"];

const COLOR_LABELS = { red: "Rot", beige: "Beige", green: "Grün" };
// The only hard coded colours in the panel: they have to match the housings.
const COLOR_SWATCHES = { red: "#C4695E", beige: "#D9C7AC", green: "#4C7A52" };

const MODE_SOURCE_HINTS = {
  hybrid:
    "Zuerst die Gruppen-ID aus dem Funktelegramm auswerten. Kommt keine an, zählt Home Assistant selbst weiter. Sobald eine bekannte Gruppen-ID gesehen wurde, bleibt es beim Gerät.",
  device:
    "Der Modus steckt in der Gruppen-ID, mit der die Fernbedienung sendet. Home Assistant liest ihn nur ab.",
  internal:
    "Home Assistant zählt den Modus selbst weiter. Die Gruppen-IDs im Funktelegramm werden ignoriert.",
};

const SLOT_HINTS = {
  click: "Einmal klicken — das Rad sendet abwechselnd Ein und Aus.",
  click_on: "Einmal klicken, während das Rad „Ein“ sendet.",
  click_off: "Einmal klicken, während das Rad „Aus“ sendet.",
  double: "Zweimal klicken.",
  triple: "Dreimal klicken.",
  wheel: "Rad drehen — absoluter Wert von 1 bis 255.",
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
  single: "einfach",
  restart: "neu starten",
  queued: "einreihen",
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
  close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  cloudOff:
    "M2.5 4.27 3.78 3l16.5 16.5-1.27 1.27-2.5-2.5H6.5A4.5 4.5 0 0 1 2.44 12a4.42 4.42 0 0 1 1.9-2.62zM19.35 10A5.5 5.5 0 0 1 18.5 21h-.67l-2-2h2.67a3.5 3.5 0 0 0 .5-6.96l-1.5-.2V10.5a5.5 5.5 0 0 0-8.4-4.68L7.6 4.38A7.5 7.5 0 0 1 19.35 10",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z",
};

/* ---------------------------------------------------------------- helpers -- */

let uidCounter = 0;

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

function modeNameOf(remote, mode) {
  const names = Array.isArray(remote && remote.mode_names) ? remote.mode_names : [];
  const name = names[Number(mode) - 1];
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

function modeLabel(remote, mode) {
  const name = modeNameOf(remote, mode);
  return name ? `Modus ${mode} · ${name}` : `Modus ${mode}`;
}

/* --------------------------------------------------- sequence in plain text -- */

const DOMAIN_LABELS = {
  light: "Licht",
  switch: "Schalter",
  fan: "Ventilator",
  cover: "Rollladen",
  lock: "Schloss",
  climate: "Klima",
  media_player: "Medienspieler",
  vacuum: "Sauger",
  humidifier: "Luftbefeuchter",
  water_heater: "Boiler",
  siren: "Sirene",
  number: "Zahl",
  input_number: "Zahl",
  select: "Auswahl",
  input_select: "Auswahl",
  input_boolean: "Schalter",
  button: "Taster",
  input_button: "Taster",
  scene: "Szene",
  script: "Skript",
  automation: "Automation",
  notify: "Benachrichtigung",
  mqtt: "MQTT",
  text: "Text",
  input_text: "Text",
};

const SERVICE_VERBS = {
  turn_on: "einschalten",
  turn_off: "ausschalten",
  toggle: "umschalten",
  open_cover: "öffnen",
  close_cover: "schließen",
  stop_cover: "anhalten",
  set_cover_position: "Position setzen",
  set_cover_tilt_position: "Lamellen setzen",
  set_value: "Wert setzen",
  select_option: "Option wählen",
  select_next: "nächste Option",
  select_previous: "vorige Option",
  set_temperature: "Temperatur setzen",
  set_hvac_mode: "Betriebsart setzen",
  set_fan_mode: "Lüfterstufe setzen",
  set_percentage: "Stufe setzen",
  volume_set: "Lautstärke setzen",
  volume_up: "lauter",
  volume_down: "leiser",
  volume_mute: "stumm schalten",
  media_play: "abspielen",
  media_pause: "pausieren",
  media_play_pause: "Wiedergabe umschalten",
  media_stop: "stoppen",
  media_next_track: "nächster Titel",
  media_previous_track: "voriger Titel",
  play_media: "Medium abspielen",
  press: "drücken",
  lock: "abschließen",
  unlock: "aufschließen",
  start: "starten",
  stop: "stoppen",
  pause: "pausieren",
  return_to_base: "zurück zur Basis",
  reload: "neu laden",
  trigger: "auslösen",
  send_message: "Nachricht senden",
  publish: "senden",
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
  if (areas.length) return areas.length === 1 ? `Bereich ${areas[0]}` : `${areas.length} Bereiche`;
  const devices = asList(target.device_id).concat(asList(step.device_id));
  if (devices.length) return devices.length === 1 ? "1 Gerät" : `${devices.length} Geräte`;
  const labels = asList(target.label_id);
  if (labels.length) return labels.length === 1 ? `Label ${labels[0]}` : `${labels.length} Labels`;
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

/** One script step as a short German phrase. */
function stepSummary(step, hass) {
  if (typeof step === "string") return step;
  if (!step || typeof step !== "object") return "Schritt";

  const service = step.action || step.service;
  if (typeof service === "string" && service.includes(".")) {
    const [domain, name] = service.split(".", 2);
    const who = targetSummary(step, hass);
    const verb = SERVICE_VERBS[name] || name.replace(/_/g, " ");

    if (domain === "script") {
      const target = name === "turn_on" || name === "turn_off" ? who : entityName(hass, service);
      return `Skript ${target || ""} ${name === "turn_off" ? "stoppen" : "starten"}`.replace(/\s+/g, " ").trim();
    }
    if (domain === "scene") return `Szene ${who || ""} aktivieren`.replace(/\s+/g, " ").trim();
    if (domain === "notify") return `Nachricht über ${name} senden`;

    const label = DOMAIN_LABELS[domain] || domain;
    // "Licht Licht Küche" reads badly: skip the domain when the name says it.
    const prefix = who && who.toLowerCase().includes(label.toLowerCase()) ? "" : label;
    return `${prefix} ${who} ${verb}`.replace(/\s+/g, " ").trim();
  }

  if (step.delay !== undefined) {
    const text = formatDelay(step.delay);
    return text ? `warten (${text})` : "warten";
  }
  if (step.wait_template !== undefined) return "auf Bedingung warten";
  if (step.wait_for_trigger !== undefined) return "auf Auslöser warten";
  if (step.choose !== undefined) return "Verzweigung (Wenn / Sonst)";
  if (step.if !== undefined) return "Wenn / Dann";
  if (step.repeat !== undefined) return "Wiederholung";
  if (step.parallel !== undefined) return "parallele Schritte";
  if (step.sequence !== undefined) return "Unterfolge";
  if (step.scene !== undefined) return `Szene ${entityName(hass, step.scene)} aktivieren`;
  if (step.event !== undefined) return `Ereignis ${step.event} auslösen`;
  if (step.variables !== undefined) return "Variablen setzen";
  if (step.condition !== undefined) return "Bedingung prüfen";
  if (step.stop !== undefined) return "Abbrechen";
  if (step.set_conversation_response !== undefined) return "Antwort setzen";
  if (step.device_id !== undefined) return `Geräteaktion (${step.domain || "Gerät"})`;
  return "Aktion";
}

/** The whole sequence in one line: one step verbatim, several as a count. */
function describeSequence(sequence, hass) {
  const steps = Array.isArray(sequence) ? sequence : sequence ? [sequence] : [];
  if (!steps.length) return "";
  const first = stepSummary(steps[0], hass);
  if (steps.length === 1) return first;
  return `${steps.length} Schritte · ${first} …`;
}

/* ------------------------------------------------------------ illustration -- */

const svgCache = new Map();

function loadIllustration(color) {
  const safe = DEFAULT_COLORS.includes(color) ? color : "beige";
  if (!svgCache.has(safe)) {
    const promise = fetch(`${IMAGE_BASE}/bilresa-${safe}.svg`, { credentials: "same-origin" })
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
    this._dialog = null;

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
    if (this._heroSvg) {
      for (let i = 1; i <= 3; i += 1) this._heroSvg.classList.remove(`mode-${i}`);
      if (current <= 3) this._heroSvg.classList.add(`mode-${current}`);
    }
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
      this._currentChip.textContent = `Am Gerät aktiv: ${modeLabel(this._remote, current)}`;
    }
  }

  /* ---------------------------------------------------------- utilities -- */

  _modeCount() {
    return Math.max(1, Math.min(MAX_MODE_COUNT, Number(this._remote && this._remote.mode_count) || 1));
  }

  _isModeless() {
    return this._remote ? this._remote.modeless_multiclick !== false : true;
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
      this._setStatus("Gespeichert.", "success");
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
    body.append(this._buildSettings());
    body.append(this._buildDanger());
    this._applyCurrentMode();
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
      "aria-label": "Name der Fernbedienung",
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
    const effective = remote.effective_mode_source;
    if (effective && effective !== remote.mode_source) {
      chips.append(
        h("span", { class: "chip neutral" }, icon("info"), h("span", {
          text: `Modusquelle wirkt als „${MODE_SOURCE_LABELS[effective] || effective}“`,
        }))
      );
    }

    const colors = (this._config && Array.isArray(this._config.colors) ? this._config.colors : DEFAULT_COLORS)
      .filter((color) => typeof color === "string");
    const swatches = h("div", {
      class: "swatches",
      role: "radiogroup",
      "aria-label": "Gehäusefarbe",
      onkeydown: (event) => this._swatchKeydown(event, colors),
    });
    for (const color of colors) {
      const active = color === remote.color;
      swatches.append(
        h("button", {
          type: "button",
          class: `swatch${active ? " is-active" : ""}`,
          role: "radio",
          "aria-checked": active ? "true" : "false",
          "aria-label": `Gehäusefarbe ${colorLabel(color)}`,
          title: colorLabel(color),
          tabindex: active ? "0" : "-1",
          "data-color": color,
          style: { "--swatch": COLOR_SWATCHES[color] || "var(--bil-text-dim)" },
          onclick: () => {
            if (color !== this._remote.color) this._patch({ color });
          },
        })
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
        h(
          "div",
          { class: "swatch-row" },
          h("span", { class: "swatch-label", text: "Gehäusefarbe" }),
          swatches
        )
      )
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
    if (color && color !== this._remote.color) this._patch({ color });
  }

  _fillHero(host, color) {
    host.textContent = "";
    const fallback = () => {
      host.textContent = "";
      const safe = DEFAULT_COLORS.includes(color) ? color : "beige";
      const wrap = h("div", { class: "hero-fallback" });
      wrap.append(
        h("img", { src: `${IMAGE_BASE}/bilresa-${safe}.svg`, alt: "", draggable: "false" })
      );
      const overlay = h("span", { class: "led-overlay" });
      const left = [41, 50, 59];
      this._heroLeds = [];
      for (let i = 0; i < 3; i += 1) {
        const dot = h("i", { style: { left: `${left[i]}%` } });
        this._heroLeds.push(dot);
        overlay.append(dot);
      }
      wrap.append(overlay);
      host.append(wrap);
      this._applyCurrentMode();
    };

    loadIllustration(color)
      .then((markup) => {
        if (!host.isConnected) return;
        host.innerHTML = markup;
        const svg = host.querySelector("svg");
        if (!svg) {
          fallback();
          return;
        }
        svg.setAttribute("focusable", "false");
        this._heroSvg = svg;
        this._heroLeds = null;
        this._applyCurrentMode();
      })
      .catch(() => {
        if (host.isConnected) fallback();
      });
  }

  async _commitName(input) {
    const name = String(input.value || "").trim();
    if (!name) {
      input.value = this._remote.name || "";
      this._setStatus("Der Name darf nicht leer sein.", "error");
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
      "aria-label": "Modi",
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
            Number(remote.current_mode) === mode ? " — am Gerät aktiv" : ""
          }. Zum Umbenennen F2 drücken.`,
          onclick: () => this._selectMode(mode),
          ondblclick: () => this._startRename(mode),
        },
        h("span", { class: "tab-index", text: String(mode) }),
        h("span", { class: "tab-name", text: name || `Modus ${mode}` }),
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
        "aria-label": `Modus ${this._activeMode} umbenennen`,
        title: "Modus umbenennen",
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
          h("h2", { text: "Modi" }),
          h("p", {
            text:
              "Jeder Modus ist ein eigener Kanal der Fernbedienung mit eigenen Aktionen. Doppelklick auf einen Reiter benennt ihn um.",
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
      "aria-label": `Name für Modus ${mode}`,
      placeholder: `Modus ${mode}`,
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
    names[mode - 1] = value || `Modus ${mode}`;
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
        h(
          "p",
          { class: "slot-note muted small" },
          `Das Rad sendet beim einfachen Klick abwechselnd „on“ und „off“. Weil „${formatAction(
            "click_on"
          )}“ und „${formatAction(
            "click_off"
          )}“ getrennt belegt sind, hängt es vom internen Zustand der Fernbedienung ab, welcher Slot läuft.`
        )
      );
    }
    return list;
  }

  _buildSlotRow(modeKey, action) {
    const binding = this._binding(modeKey, action);
    const summary = binding ? describeSequence(binding.sequence, this._hass) : "";
    const label = formatAction(action);
    const scope = modeKey === MODELESS_KEY ? "für alle Modi" : `in ${modeLabel(this._remote, Number(modeKey))}`;

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
        : h("p", { class: "slot-summary empty", text: "Noch nichts hinterlegt" })
    );

    const editBtn = h(
      "button",
      {
        type: "button",
        class: "btn small primary",
        "aria-label": `${label} ${scope} bearbeiten`,
        onclick: () => this._openDialog(modeKey, action),
      },
      icon("pencil"),
      h("span", { text: binding ? "Bearbeiten" : "Belegen" })
    );

    const testBtn = h(
      "button",
      {
        type: "button",
        class: "btn small",
        disabled: !binding,
        title: binding ? "Aktion einmal ausführen" : "Erst eine Aktion hinterlegen",
        "aria-label": `${label} ${scope} testen`,
        onclick: (event) => this._test(modeKey, action, event.currentTarget),
      },
      icon("play"),
      h("span", { text: "Testen" })
    );

    const clearBtn = h(
      "button",
      {
        type: "button",
        class: "btn small danger",
        disabled: !binding,
        "aria-label": `${label} ${scope} leeren`,
        onclick: (event) => this._armClear(event.currentTarget, modeKey, action, label),
      },
      icon("trash"),
      h("span", { text: "Leeren" })
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
      this._setStatus(`„${formatAction(action)}“ wurde einmal ausgeführt.`, "success");
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
    button.append(icon("alert"), h("span", { text: "Wirklich?" }));
    setTimeout(() => {
      if (!button.isConnected || button.dataset.armed !== "1") return;
      button.dataset.armed = "0";
      button.textContent = "";
      button.append(icon("trash"), h("span", { text: "Leeren" }));
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
      this._setStatus(`„${label}“ ist jetzt leer.`, "success");
      this._render();
      this._emitChanged();
    } catch (err) {
      button.disabled = false;
      this._setStatus(describeError(err), "error");
    }
  }

  /* ----------------------------------------------------------- modeless -- */

  _buildModeless() {
    const list = h("div", { class: "slots" });
    for (const action of ["double", "triple"]) {
      list.append(this._buildSlotRow(MODELESS_KEY, action));
      const leftovers = this._leftoverModes(action);
      if (leftovers.length) {
        list.append(
          h("p", {
            class: "slot-note muted small",
            text: `Für „${formatAction(action)}“ liegt zusätzlich etwas in ${leftovers
              .map((mode) => modeLabel(this._remote, mode))
              .join(", ")}. Das greift nur, solange dieser Slot hier leer ist.`,
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
          h("h2", { text: "Für alle Modi gemeinsam" }),
          h("p", { text: "Doppel- und Dreifachklick gelten hier unabhängig vom eingestellten Modus." })
        )
      ),
      h(
        "div",
        { class: "notice warning explain" },
        icon("info"),
        h(
          "div",
          null,
          h("strong", { text: "Warum geht das nicht pro Modus?" }),
          h("p", {
            text:
              "Einfacher Klick und Rad kommen als Groupcast an: im Funktelegramm steckt eine action_group, also die Gruppen-ID des gerade gewählten Kanals — daran erkennt Home Assistant den Modus. Doppel- und Dreifachklick sendet die Fernbedienung dagegen als Unicast, ganz ohne action_group. Im Payload steht schlicht nichts, woraus sich der Kanal ableiten ließe.",
          }),
          h("p", {
            text:
              "Deshalb liegen diese beiden Aktionen einmal für die ganze Fernbedienung hier. Wer sie trotzdem je Modus belegen will, schaltet unten „Mehrfachklicks modusunabhängig“ aus — dann wird der zuletzt bekannte Modus benutzt, was nach einem Kanalwechsel am Gerät auch daneben liegen kann.",
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
        h("span", { text: "Einstellungen" }),
        h("span", {
          class: "muted small",
          text: "Modusquelle, Slots, Radbremse, Gruppen-IDs",
        })
      )
    );

    const grid = h("div", { class: "settings-grid" });
    const sources =
      this._config && Array.isArray(this._config.mode_sources) && this._config.mode_sources.length
        ? this._config.mode_sources
        : DEFAULT_MODE_SOURCES;

    const sourceSelect = h(
      "select",
      {
        id: `${this._uid}-source`,
        onchange: (event) => this._patch({ mode_source: event.target.value }),
      },
      sources.map((source) =>
        h(
          "option",
          { value: source, selected: source === remote.mode_source },
          MODE_SOURCE_LABELS[source] || source
        )
      )
    );

    grid.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `${this._uid}-source`, text: "Modusquelle" }),
        sourceSelect,
        h("span", { class: "hint", text: MODE_SOURCE_HINTS[remote.mode_source] || "" })
      )
    );

    grid.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `${this._uid}-count`, text: "Anzahl Modi" }),
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
          text: "Das Gehäuse zeigt drei Kanäle. Mehr Modi ergeben nur mit interner Umschaltung Sinn.",
        })
      )
    );

    grid.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `${this._uid}-throttle`, text: "Radbremse (ms)" }),
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
          text: "Beim Drehen kommt ein Schwall Werte. So lange wird nach einem Lauf gewartet; der letzte Wert kommt trotzdem an.",
        })
      )
    );

    grid.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `${this._uid}-groups`, text: "Gruppen-IDs" }),
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
          text: "Die Gruppen der Kanäle aus Zigbee2MQTT, in der Reihenfolge Modus 1, 2, 3.",
        })
      )
    );

    const switches = h("div", { class: "settings-switches" });
    switches.append(
      this._switchField(
        `${this._uid}-modeless`,
        "Mehrfachklicks modusunabhängig",
        "Doppel- und Dreifachklick gelten einmal für die ganze Fernbedienung. Aus: sie hängen am zuletzt bekannten Modus.",
        remote.modeless_multiclick !== false,
        (checked) => this._patch({ modeless_multiclick: checked })
      )
    );
    switches.append(
      this._switchField(
        `${this._uid}-split`,
        "Einfachklick aufteilen",
        "Getrennte Slots für die „Ein“- und die „Aus“-Phase des Rads statt einem gemeinsamen Klick-Slot.",
        remote.split_single_click === true,
        (checked) => this._patch({ split_single_click: checked })
      )
    );

    const extra = h("div", { class: "settings-extra" });
    if (remote.mode_source === "device") {
      extra.append(
        h(
          "div",
          { class: "notice warning" },
          icon("info"),
          h(
            "div",
            null,
            h("strong", { text: "Umschalten passiert am Gerät" }),
            h("p", {
              text:
                "Die untere Taste wechselt den Kanal in der Hardware und sendet dabei nichts an Home Assistant. Eine Aktion zum Weiterschalten ist deshalb nicht nötig — der neue Kanal fällt beim nächsten Klick oder Drehen an der Gruppen-ID auf.",
            })
          )
        )
      );
    } else {
      const actions =
        this._config && Array.isArray(this._config.actions) && this._config.actions.length
          ? this._config.actions
          : DEFAULT_ACTIONS;
      const cycleSelect = h(
        "select",
        {
          id: `${this._uid}-cycle`,
          onchange: (event) => this._patch({ mode_cycle_action: event.target.value }),
        },
        actions.map((action) =>
          h(
            "option",
            { value: action, selected: action === remote.mode_cycle_action },
            formatAction(action)
          )
        )
      );
      const cycleGrid = h("div", { class: "settings-grid" });
      cycleGrid.append(
        h(
          "div",
          { class: "field" },
          h("label", { for: `${this._uid}-cycle`, text: "Aktion zum Weiterschalten" }),
          cycleSelect,
          h("span", {
            class: "hint",
            text: "Diese Aktion zählt den Modus weiter. Ein dafür hinterlegtes Skript läuft zusätzlich.",
          })
        )
      );
      cycleGrid.append(
        this._switchField(
          `${this._uid}-wrap`,
          "Nach dem letzten Modus wieder bei 1 beginnen",
          "Aus: beim letzten Modus bleibt es stehen.",
          remote.cycle_wrap !== false,
          (checked) => this._patch({ cycle_wrap: checked })
        )
      );
      extra.append(cycleGrid);
    }

    details.append(h("div", { class: "settings-body" }, grid, switches, extra));
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
      this._setStatus(`Die Anzahl der Modi muss zwischen 1 und ${MAX_MODE_COUNT} liegen.`, "error");
      return;
    }
    if (value === this._modeCount()) return;
    const names = [];
    for (let i = 1; i <= value; i += 1) names.push(modeNameOf(this._remote, i) || `Modus ${i}`);
    this._patch({ mode_count: value, mode_names: names });
  }

  _commitThrottle(input) {
    const value = Math.round(Number(input.value));
    const current = Number(this._remote.wheel_throttle_ms) || 0;
    if (!Number.isFinite(value) || value < 0 || value > 10000) {
      input.value = String(current);
      this._setStatus("Die Radbremse muss zwischen 0 und 10000 ms liegen.", "error");
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
        this._setStatus(`„${part}“ ist keine gültige Gruppen-ID (0 bis 65535).`, "error");
        return;
      }
      ids.push(value);
    }
    if (!ids.length) {
      input.value = current.join(", ");
      this._setStatus("Mindestens eine Gruppen-ID wird gebraucht.", "error");
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
        h("h2", { text: "Fernbedienung entfernen" }),
        h("p", {
          class: "muted small",
          text: `Löscht diese Fernbedienung samt ${bindingCount === 1 ? "einer hinterlegten Aktion" : `${bindingCount} hinterlegten Aktionen`}. Das Gerät selbst bleibt in Zigbee2MQTT bestehen und kann jederzeit neu eingerichtet werden.`,
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
          h("span", { text: "Löschen" })
        )
      );
      return section;
    }

    section.append(
      h(
        "div",
        { class: "confirm row wrap", role: "group", "aria-label": "Löschen bestätigen" },
        h("span", { class: "confirm-text", text: `„${this._remote.name || this._remote.ieee}“ wirklich löschen?` }),
        h(
          "button",
          {
            type: "button",
            class: "btn danger confirm-yes",
            onclick: (event) => this._delete(event.currentTarget),
          },
          icon("trash"),
          h("span", { text: "Ja, endgültig löschen" })
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
          h("span", { text: "Abbrechen" })
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
        ? `${this._remote.name || this._remote.ieee} · für alle Modi`
        : `${this._remote.name || this._remote.ieee} · ${modeLabel(this._remote, Number(modeKey))}`;
    dialog.binding = binding ? { sequence: binding.sequence, script_mode: binding.script_mode } : null;

    dialog.addEventListener("saved", () => {
      this._setStatus(`„${formatAction(action)}“ gespeichert.`, "success");
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
  background: color-mix(in srgb, var(--bil-accent) 10%, var(--bil-surface));
  font-size: 13px;
}

.editor-status.success {
  border-left-color: var(--bil-success);
  background: color-mix(in srgb, var(--bil-success) 12%, var(--bil-surface));
}

.editor-status.error {
  border-left-color: var(--bil-error);
  background: color-mix(in srgb, var(--bil-error) 12%, var(--bil-surface));
}

.section-head.tight { margin-bottom: 8px; align-items: center; }

/* ----------------------------------------------------------------- head -- */

.head { display: flex; gap: var(--bil-gap-lg); align-items: flex-start; }

.hero { flex: none; width: 116px; }
.hero svg { width: 100%; height: auto; display: block; }
.hero-fallback { position: relative; width: 100%; aspect-ratio: 200 / 330; }
.hero-fallback img { width: 100%; height: 100%; object-fit: contain; display: block; }

.hero-fallback .led-overlay { position: absolute; inset: 0; pointer-events: none; }
.hero-fallback .led-overlay i {
  position: absolute;
  top: 59.4%;
  width: 6%;
  aspect-ratio: 1;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.4);
}
.hero-fallback .led-overlay i.on {
  background: var(--bil-led-on);
  box-shadow: 0 0 5px 2px rgba(255, 243, 208, 0.7);
}

.head-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px; }

.title-input {
  font-size: 24px;
  font-weight: 700;
  padding: 8px 12px;
  border-color: transparent;
  background: transparent;
  min-height: 48px;
}

.title-input:hover { border-color: var(--divider-color, rgba(127, 127, 127, 0.28)); }
.title-input:focus { border-color: var(--bil-accent); background: var(--bil-surface); }

.head-meta { margin: 0; font-size: 12px; color: var(--bil-text-dim); overflow-wrap: anywhere; }
.head-chips { gap: 8px; }

.swatch-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }

.swatch-label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--bil-text-dim);
}

.swatches { display: flex; align-items: center; gap: 6px; }

.swatch {
  position: relative;
  width: 44px;
  height: 44px;
  border: none;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  padding: 0;
}

.swatch::before {
  content: "";
  position: absolute;
  inset: 8px;
  border-radius: 50%;
  background: var(--swatch);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
  transition: inset 0.15s ease;
}

.swatch::after {
  content: "";
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  border: 2px solid transparent;
  transition: border-color 0.15s ease;
}

.swatch:hover::before { inset: 6px; }
.swatch.is-active::after { border-color: var(--bil-accent); }
.swatch:focus-visible { outline: 2px solid var(--bil-accent); outline-offset: 2px; }

/* ----------------------------------------------------------------- tabs -- */

.tabs-scroll { overflow-x: auto; margin: 0 -4px; padding: 0 4px 4px; }

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: var(--bil-border);
  padding-bottom: 8px;
  min-width: min-content;
}

.tab {
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

.tab:focus-visible { outline: 2px solid var(--bil-accent); outline-offset: 2px; }

.tab-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  border-radius: var(--bil-pill);
  background: color-mix(in srgb, var(--bil-text) 12%, transparent);
  font-size: 12px;
}

.tab.is-selected .tab-index { background: rgba(255, 255, 255, 0.25); }

.tab-live {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--bil-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--bil-success) 30%, transparent);
}

.tab.is-current { border-color: var(--bil-success); }
.tab.is-current.is-selected { border-color: transparent; }

.tab-rename {
  min-height: 44px;
  width: 200px;
  border-radius: var(--bil-pill);
  padding: 0 16px;
}

.tabpanel { padding-top: var(--bil-gap); }
.tabpanel:focus-visible { outline: 2px solid var(--bil-accent); outline-offset: 4px; }

/* ---------------------------------------------------------------- slots -- */

.slots { display: flex; flex-direction: column; gap: 10px; }

.slot {
  display: flex;
  align-items: center;
  gap: var(--bil-gap);
  padding: 12px 14px;
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
  background: var(--bil-surface);
  transition: border-color 0.2s ease, background-color 0.4s ease;
}

.slot.is-empty {
  border-style: dashed;
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
.slot-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.slot-sub { margin: 2px 0 0; }

.slot-summary {
  margin: 4px 0 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.slot-summary.empty { color: var(--bil-text-dim); font-style: italic; }
.slot-actions { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.slot-note { margin: 0 2px; }

.chip.tiny { font-size: 11px; padding: 1px 8px; }

.notice.explain { align-items: flex-start; }
.notice.explain p + p { margin-top: 8px; }

/* ------------------------------------------------------------- settings -- */

.settings { padding: 0; }

.settings-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px var(--bil-gap);
  min-height: 56px;
  cursor: pointer;
  font-weight: 600;
  list-style: none;
  border-radius: var(--bil-radius-lg);
}

.settings-summary::-webkit-details-marker { display: none; }
.settings-summary:hover { background: color-mix(in srgb, var(--bil-text) 5%, transparent); }
.settings-summary:focus-visible { outline: 2px solid var(--bil-accent); outline-offset: -2px; }
.settings[open] .settings-summary { border-bottom: var(--bil-border); border-radius: var(--bil-radius-lg) var(--bil-radius-lg) 0 0; }

.settings-body {
  display: flex;
  flex-direction: column;
  gap: var(--bil-gap-lg);
  padding: var(--bil-gap-lg) var(--bil-gap);
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--bil-gap);
  align-items: start;
}

.settings-switches { display: flex; flex-direction: column; gap: var(--bil-gap); }

.switch-field { display: flex; align-items: flex-start; gap: 12px; }
.switch-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.switch-label { font-weight: 600; cursor: pointer; }

.switch {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  width: 52px;
  height: 44px;
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

.settings-extra { display: flex; flex-direction: column; gap: var(--bil-gap); }

/* --------------------------------------------------------------- danger -- */

.danger {
  display: flex;
  align-items: center;
  gap: var(--bil-gap);
  flex-wrap: wrap;
  border: 1px solid color-mix(in srgb, var(--bil-error) 35%, transparent);
}

.danger-text { flex: 1 1 320px; min-width: 0; }
.danger-text h2 { margin: 0; font-size: 15px; font-weight: 600; }
.danger-text p { margin: 4px 0 0; }
.danger .confirm { gap: 10px; }
.danger .confirm-text { font-weight: 600; }

/* ----------------------------------------------------------- responsive -- */

@media (max-width: 700px) {
  .head { flex-direction: row; gap: var(--bil-gap); }
  .hero { width: 76px; }
  .title-input { font-size: 20px; }
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
