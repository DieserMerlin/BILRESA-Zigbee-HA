/**
 * BILRESA panel shell: routing, overview, discovery and the live action strip.
 *
 * Plain custom elements, no framework and no build step. The editor and the
 * guide live in their own modules and are used as <bilresa-remote-editor> and
 * <bilresa-guide>; both receive `hass`, `config` and (editor only) `remote` as
 * properties and may fire a bubbling `changed` event when data was written.
 */

import "./remote-editor.js";
import "./guide.js";

import { sharedStyles } from "./styles.js";
import {
  createRemote,
  describeError,
  discover,
  formatAction,
  isValidIeee,
  loadConfig,
  normalizeIeee,
  subscribeEvents,
  MODELESS_KEY,
} from "./api.js";

const IMAGE_BASE = "/bilresa_remote/images";
const DEFAULT_COLORS = ["red", "beige", "green"];
const COLOR_LABELS = { red: "Rot", beige: "Beige", green: "Grün" };

const ICONS = {
  menu: "M3 6h18v2H3V6m0 5h18v2H3v-2m0 5h18v2H3v-2z",
  back: "M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z",
  refresh:
    "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z",
  help:
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m1 17h-2v-2h2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26A2 2 0 0 0 12 7a2 2 0 0 0-2 2H8a4 4 0 1 1 8 0c0 .88-.36 1.68-.93 2.25",
  search:
    "M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l.27.27h.79l5 5-1.5 1.5-5-5v-.79l-.27-.27A6.47 6.47 0 0 1 9.5 16 6.5 6.5 0 1 1 9.5 3m0 2A4.5 4.5 0 1 0 14 9.5 4.5 4.5 0 0 0 9.5 5",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z",
  alert: "M13 14h-2V9h2m0 9h-2v-2h2M1 21h22L12 2z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  info: "M13 9h-2V7h2m0 10h-2v-6h2m-1-9A10 10 0 0 0 2 12a10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2",
  remote:
    "M12 2a6 6 0 0 1 6 6v8a6 6 0 0 1-12 0V8a6 6 0 0 1 6-6m0 2a4 4 0 0 0-4 4v8a4 4 0 0 0 8 0V8a4 4 0 0 0-4-4m0 2.5A2.5 2.5 0 1 1 9.5 9 2.5 2.5 0 0 1 12 6.5m-3 10a1 1 0 1 1 1 1 1 1 0 0 1-1-1m3 0a1 1 0 1 1 1 1 1 1 0 0 1-1-1m3 0a1 1 0 1 1 1 1 1 1 0 0 1-1-1",
  wheel:
    "M12 4a8 8 0 1 0 8 8 8 8 0 0 0-8-8m0 2a6 6 0 1 1-6 6 6 6 0 0 1 6-6m0 2.5A3.5 3.5 0 1 0 15.5 12 3.5 3.5 0 0 0 12 8.5",
  cloudOff:
    "M2.5 4.27 3.78 3l16.5 16.5-1.27 1.27-2.5-2.5H6.5A4.5 4.5 0 0 1 2.44 12a4.42 4.42 0 0 1 1.9-2.62zM19.35 10A5.5 5.5 0 0 1 18.5 21h-.67l-2-2h2.67a3.5 3.5 0 0 0 .5-6.96l-1.5-.2V10.5a5.5 5.5 0 0 0-8.4-4.68L7.6 4.38A7.5 7.5 0 0 1 19.35 10",
};

/* ------------------------------------------------------------- helpers -- */

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

function imageUrl(color) {
  const safe = DEFAULT_COLORS.includes(color) ? color : "beige";
  return `${IMAGE_BASE}/bilresa-${safe}.svg`;
}

function colorLabel(color) {
  return COLOR_LABELS[color] || color || "";
}

/** Illustration plus the LED overlay that mirrors the active channel. */
function remoteVisual(color, activeMode, modeCount) {
  const count = Math.min(3, Math.max(1, Number(modeCount) || 3));
  const overlay = h("span", { class: "led-overlay" });
  const left = [41, 50, 59];
  for (let i = 0; i < count; i += 1) {
    overlay.append(
      h("i", {
        class: Number(activeMode) === i + 1 ? "on" : "",
        style: { left: `${left[i]}%` },
      })
    );
  }
  return h(
    "div",
    { class: "remote-visual" },
    h("img", { src: imageUrl(color), alt: "", loading: "lazy", draggable: "false" }),
    overlay
  );
}

function modeName(remote, mode) {
  const names = Array.isArray(remote.mode_names) ? remote.mode_names : [];
  const name = names[Number(mode) - 1];
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

/**
 * How many of the bindable slots are filled. The number of slots depends on the
 * per-remote switches: splitting the single click adds one slot per mode, and
 * mode-independent multiclicks move double/triple out of every mode into "*".
 */
function slotStats(remote) {
  const modeCount = Math.max(1, Number(remote.mode_count) || 1);
  const modeless = remote.modeless_multiclick !== false;
  const split = remote.split_single_click === true;
  const perMode = (split ? 2 : 1) + 1 + (modeless ? 0 : 2);
  let used = 0;
  const bindings = remote.bindings && typeof remote.bindings === "object" ? remote.bindings : {};
  for (const key of Object.keys(bindings)) {
    const slots = bindings[key];
    if (!slots || typeof slots !== "object") continue;
    for (const action of Object.keys(slots)) {
      if (slots[action]) used += 1;
    }
  }
  const total = modeCount * perMode + (modeless ? 2 : 0);
  return { used, total: Math.max(total, used) };
}

function parsePath(rawPath) {
  const path = String(rawPath || "/").split("?")[0].split("#")[0];
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "guide") return { view: "guide", id: "" };
  if (parts[0] === "remote" && parts[1]) return { view: "remote", id: decodeURIComponent(parts[1]) };
  return { view: "overview", id: "" };
}

function formatTime(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/* --------------------------------------------------------------- panel -- */

class BilresaPanel extends HTMLElement {
  static get properties() {
    return { hass: {}, narrow: { type: Boolean }, route: {}, panel: {} };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._hass = null;
    this._narrow = false;
    this._route = null;
    this._panel = null;

    this._activePath = "/";
    this._viewKey = "";
    this._initialized = false;
    this._overviewBuilt = false;
    this._editorEl = null;
    this._guideEl = null;

    this._unsub = null;
    this._subConnection = null;
    this._subscribing = false;
    this._subFailed = false;
    this._flashTimer = null;
    this._reloadTimer = null;
    this._creating = false;
    this._discoverAttempted = false;

    this._manual = { ieee: "", name: "", color: "" };
    this._state = {
      config: null,
      loading: true,
      error: null,
      discovery: null,
      discovering: false,
      discoverError: null,
      lastEvent: null,
      liveError: null,
    };

    this._onChanged = this._onChanged.bind(this);
    this._buildShell();
  }

  /* ------------------------------------------------------- properties -- */

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._editorEl) this._editorEl.hass = hass;
    if (this._guideEl) this._guideEl.hass = hass;
    if (first && this.isConnected) this._init();
    else this._maybeSubscribe();
  }

  get hass() {
    return this._hass;
  }

  set narrow(value) {
    this._narrow = Boolean(value);
    this.toggleAttribute("narrow", this._narrow);
    this._updateChrome();
  }

  get narrow() {
    return this._narrow;
  }

  set route(route) {
    this._route = route;
    const path = route && route.path ? route.path : "/";
    this._activePath = path.startsWith("/") ? path : `/${path}`;
    if (this._initialized) this._renderView();
  }

  get route() {
    return this._route;
  }

  set panel(panel) {
    this._panel = panel;
    this._updateChrome();
  }

  get panel() {
    return this._panel;
  }

  /* ------------------------------------------------------- lifecycle --- */

  connectedCallback() {
    this.shadowRoot.addEventListener("changed", this._onChanged);
    if (!this._hass) return;
    this._init();
    // Re-attaching the element (panel switch) must restore the live stream.
    this._maybeSubscribe();
  }

  disconnectedCallback() {
    this.shadowRoot.removeEventListener("changed", this._onChanged);
    this._unsubscribe();
    if (this._flashTimer) clearTimeout(this._flashTimer);
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
    this._flashTimer = null;
    this._reloadTimer = null;
  }

  _init() {
    if (this._initialized) return;
    this._initialized = true;
    this._renderView(true);
    this._maybeSubscribe();
    this._reload();
  }

  /* ------------------------------------------------------------ shell -- */

  _buildShell() {
    const style = document.createElement("style");
    style.textContent = sharedStyles;

    this._menuBtn = h("button", {
      type: "button",
      class: "icon-btn",
      title: "Menü",
      "aria-label": "Menü öffnen",
      hidden: true,
      onclick: () => this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true })),
    }, icon("menu"));

    this._backBtn = h("button", {
      type: "button",
      class: "icon-btn",
      title: "Zurück zur Übersicht",
      "aria-label": "Zurück zur Übersicht",
      hidden: true,
      onclick: () => this._navigate("/"),
    }, icon("back"));

    this._title = h("h1", { text: "BILRESA" });
    this._subtitle = h("p", { class: "sub" });

    this._guideBtn = h("button", {
      type: "button",
      class: "btn ghost small",
      onclick: () => this._navigate("/guide"),
    }, icon("help"), h("span", { text: "Anleitung" }));

    this._refreshBtn = h("button", {
      type: "button",
      class: "icon-btn",
      title: "Aktualisieren",
      "aria-label": "Aktualisieren",
      onclick: () => this._reload({ manual: true }),
    }, icon("refresh"));

    const topbar = h(
      "header",
      { class: "topbar" },
      this._menuBtn,
      this._backBtn,
      h("div", { class: "titles" }, this._title, this._subtitle),
      h("div", { class: "spacer" }),
      h("div", { class: "topbar-actions" }, this._guideBtn, this._refreshBtn)
    );

    this._liveBar = h("div", { class: "livebar", role: "status", "aria-live": "polite" });
    this._content = h("main", { class: "content" });
    this._toasts = h("div", { class: "toasts" });

    const chrome = h("div", { class: "chrome" }, topbar, this._liveBar);
    this.shadowRoot.append(style, h("div", { class: "app" }, chrome, this._content), this._toasts);
    this._renderLiveBar();
  }

  _updateChrome() {
    const { view, id } = parsePath(this._activePath);
    if (this._backBtn) this._backBtn.hidden = view === "overview";
    if (this._guideBtn) this._guideBtn.hidden = view === "guide";
    if (this._menuBtn) this._menuBtn.hidden = !this._narrow || view !== "overview";
    if (this._title) this._title.textContent = (this._panel && this._panel.title) || "BILRESA";
    if (!this._subtitle) return;

    if (view === "guide") {
      this._subtitle.textContent = "Anleitung";
      return;
    }
    if (view === "remote") {
      const remote = this._remoteById(id);
      this._subtitle.textContent = remote ? remote.name || remote.ieee : "Fernbedienung";
      return;
    }
    const config = this._state.config;
    if (!config) {
      this._subtitle.textContent = "Fernbedienungen einrichten";
      return;
    }
    const count = (config.remotes || []).length;
    const label = count === 1 ? "1 Fernbedienung" : `${count} Fernbedienungen`;
    this._subtitle.textContent = `${label} · Basis-Topic „${config.base_topic || "zigbee2mqtt"}“`;
  }

  /* ------------------------------------------------------------ routing -- */

  _prefix() {
    if (this._route && this._route.prefix) return this._route.prefix;
    if (this._panel && this._panel.url_path) return `/${this._panel.url_path}`;
    const first = window.location.pathname.split("/").filter(Boolean)[0];
    return first ? `/${first}` : "";
  }

  _navigate(path) {
    const target = `${this._prefix()}${path}`;
    this._activePath = path;
    if (window.location.pathname !== target) {
      window.history.pushState(null, "", target);
    }
    // The frontend router listens for this on window (see common/navigate).
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
    this._renderView();
  }

  _remoteById(id) {
    const remotes = (this._state.config && this._state.config.remotes) || [];
    return remotes.find((remote) => remote.subentry_id === id) || null;
  }

  /* ------------------------------------------------------------- data --- */

  async _reload({ manual = false, silent = false } = {}) {
    if (!this._hass) return;
    if (!silent) {
      this._state.loading = true;
      if (manual) {
        this._state.error = null;
        this._subFailed = false;
        this._maybeSubscribe();
      }
      this._renderView(true);
    }
    try {
      const config = await loadConfig(this._hass);
      this._state.config = config;
      this._state.error = null;
    } catch (err) {
      this._state.error = describeError(err);
      if (silent) this._toast(this._state.error, "error");
    } finally {
      this._state.loading = false;
      if (!this.isConnected) return;
      this._renderView(true);
    }
  }

  _scheduleReload() {
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = null;
      this._reload({ silent: true }).then(() => {
        const { view, id } = parsePath(this._activePath);
        if (view === "remote" && this._state.config && !this._remoteById(id)) this._navigate("/");
      });
    }, 150);
  }

  _onChanged() {
    this._scheduleReload();
  }

  async _runDiscovery(force) {
    if (!this._hass || this._state.discovering) return;
    this._discoverAttempted = true;
    this._state.discovering = true;
    this._state.discoverError = null;
    this._renderDiscovery();
    try {
      this._state.discovery = await discover(this._hass, force);
    } catch (err) {
      this._state.discoverError = describeError(err);
    } finally {
      this._state.discovering = false;
      this._renderDiscovery();
    }
  }

  async _createRemote(payload, device) {
    if (this._creating) return;
    this._creating = true;
    this._renderDiscovery();
    try {
      const result = await createRemote(this._hass, payload);
      if (device) device.configured = true;
      await this._reload({ silent: true });
      this._toast("Fernbedienung angelegt.", "success");
      if (result && result.subentry_id) {
        this._navigate(`/remote/${encodeURIComponent(result.subentry_id)}`);
      }
    } catch (err) {
      this._toast(describeError(err), "error");
    } finally {
      this._creating = false;
      this._renderDiscovery();
    }
  }

  /* ------------------------------------------------------------ events -- */

  _maybeSubscribe() {
    if (!this.isConnected || !this._hass || !this._hass.connection) return;
    if (this._subscribing) return;
    // hass is reassigned on every state change, so a failed attempt must not be
    // retried until the connection is replaced or the user hits refresh.
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
      const unsub = await subscribeEvents(this._hass, (event) => this._onAction(event));
      if (!this.isConnected) {
        Promise.resolve(unsub()).catch(() => {});
        return;
      }
      this._unsub = unsub;
      this._state.liveError = null;
    } catch (err) {
      this._subFailed = true;
      this._state.liveError = describeError(err);
    } finally {
      this._subscribing = false;
      this._renderLiveBar();
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
        // The socket may already be gone; nothing left to clean up.
      }
    }
  }

  _onAction(event) {
    if (!event || typeof event !== "object") return;
    this._state.lastEvent = event;

    const remote = this._remoteById(event.subentry_id);
    if (remote && Number.isInteger(event.mode) && remote.current_mode !== event.mode) {
      remote.current_mode = event.mode;
      if (parsePath(this._activePath).view === "overview") this._renderRemotes();
    }
    if (this._editorEl) {
      this._editorEl.lastEvent = event;
      this._editorEl.dispatchEvent(
        new CustomEvent("bilresa-action", { detail: event, bubbles: false })
      );
    }
    this._renderLiveBar(true);
  }

  _renderLiveBar(flash = false) {
    const bar = this._liveBar;
    if (!bar) return;
    bar.textContent = "";
    const event = this._state.lastEvent;

    bar.classList.toggle("is-live", Boolean(event));
    bar.append(h("span", { class: "pulse" }));

    if (this._state.liveError) {
      bar.append(
        h("span", { class: "live-text", text: "Live-Anzeige nicht verfügbar" }),
        h("span", { class: "live-meta", text: this._state.liveError })
      );
      return;
    }

    if (!event) {
      bar.append(
        h("span", { class: "live-text muted", text: "Warte auf einen Tastendruck …" }),
        h("span", {
          class: "live-meta",
          text: "Drücke das Rad, um zu sehen welche Fernbedienung ankommt.",
        })
      );
      return;
    }

    const remote = this._remoteById(event.subentry_id);
    const name = (remote && remote.name) || event.ieee || "Unbekannte Fernbedienung";
    const parts = [name];
    if (event.mode_key === MODELESS_KEY) {
      parts.push("modusunabhängig");
    } else if (event.mode) {
      const label = remote ? modeName(remote, event.mode) : "";
      parts.push(label ? `Modus ${event.mode} · ${label}` : `Modus ${event.mode}`);
    }
    parts.push(formatAction(event.action));
    if (event.action === "wheel") {
      if (event.level_pct !== undefined && event.level_pct !== null) {
        parts.push(`${event.level_pct} %`);
      }
      if (event.direction) parts.push(event.direction === "down" ? "abwärts" : "aufwärts");
    }

    bar.append(h("span", { class: "live-text", text: parts.join(" · ") }));
    bar.append(h("span", { class: "live-meta", text: formatTime(event.timestamp) }));
    bar.append(h("span", { class: "spacer" }));
    bar.append(
      event.has_binding === false
        ? h("span", { class: "chip warning" }, icon("alert"), h("span", { text: "kein Skript" }))
        : h("span", { class: "chip success" }, icon("check"), h("span", { text: "Skript läuft" }))
    );

    if (flash) {
      bar.classList.add("is-hot");
      if (this._flashTimer) clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => {
        bar.classList.remove("is-hot");
        this._flashTimer = null;
      }, 900);
    }
  }

  /* ------------------------------------------------------------ toasts -- */

  _toast(message, kind = "info") {
    if (!this._toasts) return;
    const node = h(
      "div",
      { class: `toast ${kind}` },
      icon(kind === "error" ? "alert" : kind === "success" ? "check" : "info"),
      h("span", { text: message })
    );
    this._toasts.append(node);
    setTimeout(() => {
      node.classList.add("leaving");
      setTimeout(() => node.remove(), 240);
    }, 4200);
  }

  /* ------------------------------------------------------------ render -- */

  _renderView(force = false) {
    const { view, id } = parsePath(this._activePath);
    const key = `${view}:${id}`;
    const changed = key !== this._viewKey;
    this._viewKey = key;

    if (changed) {
      this._content.textContent = "";
      this._overviewBuilt = false;
      if (view !== "remote") this._editorEl = null;
      if (view !== "guide") this._guideEl = null;
    }

    if (view === "guide") this._renderGuide();
    else if (view === "remote") this._renderEditor(id);
    else this._renderOverview(force || changed);

    this._setRefreshBusy(this._state.loading);
    this._updateChrome();
  }

  _setRefreshBusy(busy) {
    if (!this._refreshBtn) return;
    this._refreshBtn.disabled = Boolean(busy);
    this._refreshBtn.textContent = "";
    this._refreshBtn.append(icon("refresh", busy ? "spin" : ""));
  }

  _renderGuide() {
    if (!this._guideEl || !this._guideEl.isConnected) {
      this._content.textContent = "";
      this._guideEl = document.createElement("bilresa-guide");
      this._content.append(this._guideEl);
    }
    this._guideEl.hass = this._hass;
    this._guideEl.config = this._state.config;
  }

  _renderEditor(id) {
    const state = this._state;
    if (!state.config) {
      this._content.textContent = "";
      this._content.append(
        state.error ? this._errorCard(state.error) : this._skeletonGrid(1)
      );
      return;
    }
    const remote = this._remoteById(id);
    if (!remote) {
      this._editorEl = null;
      this._content.textContent = "";
      this._content.append(
        this._emptyCard(
          "remote",
          "Diese Fernbedienung gibt es nicht mehr.",
          "Sie wurde vermutlich gelöscht. Zurück zur Übersicht, um eine andere zu wählen.",
          [
            h(
              "button",
              { type: "button", class: "btn primary", onclick: () => this._navigate("/") },
              h("span", { text: "Zur Übersicht" })
            ),
          ]
        )
      );
      return;
    }
    // __bilresaId is bookkeeping for this shell only — never a contract field.
    if (!this._editorEl || this._editorEl.__bilresaId !== id || !this._editorEl.isConnected) {
      this._content.textContent = "";
      this._editorEl = document.createElement("bilresa-remote-editor");
      this._editorEl.__bilresaId = id;
      this._content.append(this._editorEl);
    }
    this._editorEl.hass = this._hass;
    this._editorEl.config = state.config;
    this._editorEl.remote = remote;
  }

  _renderOverview(rebuild) {
    if (rebuild || !this._overviewBuilt) {
      this._content.textContent = "";
      this._content.append(
        h(
          "section",
          { class: "section" },
          h(
            "div",
            { class: "section-head" },
            h(
              "div",
              null,
              h("h2", { text: "Deine Fernbedienungen" }),
              h("p", { text: "Tippe auf eine Karte, um Modi und Aktionen zu bearbeiten." })
            ),
            h("div", { class: "spacer" })
          ),
          h("div", { id: "remotes" })
        ),
        this._buildAddSection()
      );
      this._overviewBuilt = true;
    }
    this._renderRemotes();
    this._renderDiscovery();

    if (!this._discoverAttempted && this._state.config && !this._state.discovering) {
      this._runDiscovery(false);
    }
  }

  _renderRemotes() {
    const host = this._content.querySelector("#remotes");
    if (!host) return;
    host.textContent = "";
    const state = this._state;

    if (state.error && !state.config) {
      host.append(this._errorCard(state.error));
      return;
    }
    if (!state.config) {
      host.append(this._skeletonGrid(3));
      return;
    }
    const remotes = state.config.remotes || [];
    if (!remotes.length) {
      host.append(
        this._emptyCard(
          "remote",
          "Noch keine Fernbedienung eingerichtet",
          "Suche unten nach BILRESA-Fernbedienungen in Zigbee2MQTT oder trage die IEEE-Adresse von Hand ein. Die Anleitung erklärt, wie Rad, Modi und Slots zusammenspielen.",
          [
            h(
              "button",
              { type: "button", class: "btn primary", onclick: () => this._runDiscovery(true) },
              icon("search"),
              h("span", { text: "Jetzt suchen" })
            ),
            h(
              "button",
              { type: "button", class: "btn", onclick: () => this._navigate("/guide") },
              icon("help"),
              h("span", { text: "Anleitung öffnen" })
            ),
          ]
        )
      );
      return;
    }
    const grid = h("div", { class: "grid" });
    for (const remote of remotes) grid.append(this._remoteCard(remote));
    host.append(grid);
    if (state.error) host.append(this._noticeCard(state.error, true));
  }

  _remoteCard(remote) {
    const stats = slotStats(remote);
    const mode = Number(remote.current_mode) || 1;
    const name = modeName(remote, mode);
    const percent = stats.total ? Math.round((stats.used / stats.total) * 100) : 0;
    const available = remote.available !== false;

    const chips = h(
      "div",
      { class: "row wrap" },
      h("span", { class: "chip" }, icon("wheel"), h("span", {
        text: name ? `Modus ${mode} · ${name}` : `Modus ${mode}`,
      })),
      available
        ? null
        : h("span", { class: "chip error" }, icon("cloudOff"), h("span", { text: "Offline" }))
    );

    const foot = h(
      "div",
      { class: "remote-foot" },
      h("span", { class: "small muted", text: `${stats.used} von ${stats.total} Slots belegt` })
    );

    const bar = h("div", { class: "slotbar" }, h("span", { style: { width: `${percent}%` } }));

    return h(
      "button",
      {
        type: "button",
        class: "card remote-card",
        "aria-label": `${remote.name || remote.ieee} bearbeiten`,
        onclick: () => this._navigate(`/remote/${encodeURIComponent(remote.subentry_id)}`),
      },
      remoteVisual(remote.color, mode, remote.mode_count),
      h(
        "div",
        { class: "remote-body" },
        h("h3", { class: "remote-name", text: remote.name || "Ohne Namen" }),
        h("p", { class: "remote-meta", text: remote.ieee || "" }),
        chips,
        foot,
        bar
      )
    );
  }

  /* -------------------------------------------------------------- add --- */

  _buildAddSection() {
    const colors = (this._state.config && this._state.config.colors) || DEFAULT_COLORS;
    if (!this._manual.color) this._manual.color = colors.includes("beige") ? "beige" : colors[0];

    const searchBtn = h(
      "button",
      { type: "button", class: "btn primary", onclick: () => this._runDiscovery(true) },
      icon("search"),
      h("span", { text: "Suchen" })
    );
    this._searchBtn = searchBtn;

    const ieeeInput = h("input", {
      type: "text",
      id: "manual-ieee",
      class: "mono",
      placeholder: "0x1035970000a197b8",
      spellcheck: "false",
      autocomplete: "off",
      autocapitalize: "off",
      value: this._manual.ieee,
      oninput: (event) => {
        this._manual.ieee = event.target.value;
        this._setManualHint("");
      },
      onkeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this._submitManual();
        }
      },
    });
    this._ieeeInput = ieeeInput;

    const nameInput = h("input", {
      type: "text",
      id: "manual-name",
      placeholder: "z. B. Küche",
      value: this._manual.name,
      oninput: (event) => {
        this._manual.name = event.target.value;
      },
    });

    const colorSelect = h(
      "select",
      {
        id: "manual-color",
        onchange: (event) => {
          this._manual.color = event.target.value;
        },
      },
      colors.map((color) =>
        h("option", { value: color, selected: color === this._manual.color }, colorLabel(color))
      )
    );

    this._manualHint = h("div", {
      class: "hint",
      text: "Steht in Zigbee2MQTT auf der Geräteseite als „IEEE Address“.",
    });

    return h(
      "section",
      { class: "section" },
      h(
        "div",
        { class: "section-head" },
        h(
          "div",
          null,
          h("h2", { text: "Fernbedienung hinzufügen" }),
          h("p", {
            text: "Zigbee2MQTT nach BILRESA-Fernbedienungen fragen — der Kommentar aus Z2M hilft beim Auseinanderhalten.",
          })
        ),
        h("div", { class: "spacer" }),
        searchBtn
      ),
      h(
        "div",
        { class: "card pad-lg stack" },
        h("div", { id: "discovery" }),
        h(
          "div",
          { class: "stack tight" },
          h("h3", { class: "small muted", text: "ODER MANUELL EINTRAGEN" }),
          h(
            "div",
            { class: "inline-form" },
            h(
              "div",
              { class: "field" },
              h("label", { for: "manual-ieee", text: "IEEE-Adresse" }),
              ieeeInput,
              this._manualHint
            ),
            h(
              "div",
              { class: "field" },
              h("label", { for: "manual-name", text: "Name" }),
              nameInput
            ),
            h(
              "div",
              { class: "field" },
              h("label", { for: "manual-color", text: "Gehäusefarbe" }),
              colorSelect
            ),
            h(
              "button",
              { type: "button", class: "btn primary", onclick: () => this._submitManual() },
              icon("plus"),
              h("span", { text: "Hinzufügen" })
            )
          )
        )
      )
    );
  }

  _setManualHint(message, isError = true) {
    if (!this._manualHint) return;
    if (!message) {
      this._manualHint.className = "hint";
      this._manualHint.textContent = "Steht in Zigbee2MQTT auf der Geräteseite als „IEEE Address“.";
      return;
    }
    this._manualHint.className = isError ? "hint error" : "hint";
    this._manualHint.textContent = message;
  }

  _submitManual() {
    const raw = (this._manual.ieee || "").trim();
    if (!raw) {
      this._setManualHint("Bitte eine IEEE-Adresse eintragen.");
      if (this._ieeeInput) this._ieeeInput.focus();
      return;
    }
    const ieee = normalizeIeee(raw);
    if (!isValidIeee(ieee)) {
      this._setManualHint("Das ist keine gültige IEEE-Adresse (0x + 16 Hex-Zeichen).");
      if (this._ieeeInput) this._ieeeInput.focus();
      return;
    }
    this._setManualHint("");
    this._createRemote({
      ieee,
      name: (this._manual.name || "").trim() || undefined,
      color: this._manual.color,
    });
  }

  _renderDiscovery() {
    const host = this._content.querySelector("#discovery");
    if (!host) return;
    host.textContent = "";
    const state = this._state;

    if (this._searchBtn) {
      this._searchBtn.disabled = state.discovering;
      this._searchBtn.textContent = "";
      this._searchBtn.append(
        icon("search", state.discovering ? "spin" : ""),
        h("span", { text: state.discovering ? "Suche …" : "Suchen" })
      );
    }

    if (state.discovering) {
      host.append(this._skeletonGrid(2));
      return;
    }
    if (state.discoverError) {
      host.append(
        this._noticeCard(state.discoverError, true, () => this._runDiscovery(true))
      );
      return;
    }
    if (!state.discovery) {
      host.append(
        h("p", {
          class: "muted small",
          text: "Noch nicht gesucht. „Suchen“ fragt Zigbee2MQTT nach allen bekannten Geräten.",
        })
      );
      return;
    }
    if (state.discovery.z2m_available === false) {
      host.append(
        this._noticeCard(
          "Zigbee2MQTT hat nicht geantwortet. Prüfe die MQTT-Verbindung oder trage die IEEE-Adresse unten von Hand ein.",
          false,
          () => this._runDiscovery(true)
        )
      );
      return;
    }

    const devices = (state.discovery.devices || []).filter((device) => !device.configured);
    if (!devices.length) {
      host.append(
        h("p", {
          class: "muted small",
          text: "Alle gefundenen BILRESA-Fernbedienungen sind bereits eingerichtet.",
        })
      );
      return;
    }
    const grid = h("div", { class: "grid" });
    for (const device of devices) grid.append(this._deviceCard(device));
    host.append(grid);
  }

  _deviceCard(device) {
    const color = device.suggested_color || "beige";
    const title = device.comment || colorLabel(color) || device.friendly_name || device.ieee;

    return h(
      "button",
      {
        type: "button",
        class: "card outline remote-card",
        disabled: this._creating,
        "aria-label": `${title} einrichten`,
        onclick: () =>
          this._createRemote(
            {
              ieee: device.ieee,
              name: device.comment || device.friendly_name || undefined,
              color,
            },
            device
          ),
      },
      remoteVisual(color, 1, 3),
      h(
        "div",
        { class: "remote-body" },
        h("h3", { class: "remote-name", text: title }),
        h("p", { class: "remote-meta", text: device.ieee || "" }),
        h(
          "div",
          { class: "row wrap" },
          h("span", { class: "chip neutral", text: device.model || "E2490" }),
          h("span", { class: "chip", text: colorLabel(color) })
        ),
        h(
          "div",
          { class: "remote-foot" },
          h("span", { class: "small muted", text: "Tippen, um einzurichten" })
        )
      )
    );
  }

  /* ------------------------------------------------------------ pieces -- */

  _skeletonGrid(count) {
    const grid = h("div", { class: "grid" });
    for (let i = 0; i < count; i += 1) {
      grid.append(
        h(
          "div",
          { class: "card remote-card" },
          h("div", { class: "remote-visual skeleton" }),
          h(
            "div",
            { class: "remote-body stack tight" },
            h("div", { class: "skeleton line mid" }),
            h("div", { class: "skeleton line short" }),
            h("div", { class: "skeleton line" })
          )
        )
      );
    }
    return grid;
  }

  _noticeCard(message, isError = true, retry) {
    const node = h(
      "div",
      { class: isError ? "notice" : "notice warning" },
      icon("alert"),
      h(
        "div",
        null,
        h("strong", { text: isError ? "Fehler" : "Hinweis" }),
        h("p", { text: message })
      )
    );
    if (retry) {
      node.append(h("div", { class: "spacer" }));
      node.append(
        h(
          "button",
          { type: "button", class: "btn small", onclick: () => retry() },
          icon("refresh"),
          h("span", { text: "Erneut versuchen" })
        )
      );
    }
    return node;
  }

  _errorCard(message) {
    return h(
      "div",
      { class: "card pad-lg" },
      h(
        "div",
        { class: "empty" },
        icon("alert", "big"),
        h("h3", { text: "Die Konfiguration konnte nicht geladen werden" }),
        h("p", { text: message }),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            { type: "button", class: "btn primary", onclick: () => this._reload({ manual: true }) },
            icon("refresh"),
            h("span", { text: "Erneut versuchen" })
          ),
          h(
            "button",
            { type: "button", class: "btn", onclick: () => this._navigate("/guide") },
            icon("help"),
            h("span", { text: "Anleitung" })
          )
        )
      )
    );
  }

  _emptyCard(iconName, headline, text, actions) {
    return h(
      "div",
      { class: "card pad-lg" },
      h(
        "div",
        { class: "empty" },
        icon(iconName, "big"),
        h("h3", { text: headline }),
        h("p", { text }),
        actions && actions.length ? h("div", { class: "row wrap" }, actions) : null
      )
    );
  }
}

if (!customElements.get("bilresa-panel")) {
  customElements.define("bilresa-panel", BilresaPanel);
}

export { BilresaPanel };
