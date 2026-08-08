/**
 * Thin websocket client for the bilresa_remote panel.
 *
 * One exported function per command in ws_contract.md — no command, field or
 * fallback that the contract does not define. Every rejection is normalised to
 * a BilresaError carrying `code` and `message` so callers can branch on the
 * documented error codes instead of parsing strings.
 */

/** Mode key used for mode-independent slots (double/triple click). */
export const MODELESS_KEY = "*";

/** Command names, exactly as registered by the integration. */
export const WS = Object.freeze({
  CONFIG: "bilresa_remote/config",
  DISCOVER: "bilresa_remote/discover",
  REMOTE_CREATE: "bilresa_remote/remote/create",
  REMOTE_UPDATE: "bilresa_remote/remote/update",
  REMOTE_DELETE: "bilresa_remote/remote/delete",
  BINDING_SET: "bilresa_remote/binding/set",
  BINDING_CLEAR: "bilresa_remote/binding/clear",
  BINDING_TEST: "bilresa_remote/binding/test",
  SUBSCRIBE_EVENTS: "bilresa_remote/subscribe_events",
});

/** Fields `remote/create` accepts. Anything else is rejected by the backend. */
const CREATE_FIELDS = Object.freeze([
  "ieee",
  "name",
  "color",
  "mode_source",
  "mode_count",
  "mode_names",
  "modeless_multiclick",
]);

export const ACTION_LABELS = Object.freeze({
  click: "Klick",
  click_on: "Klick (Ein)",
  click_off: "Klick (Aus)",
  double: "Doppelklick",
  triple: "Dreifachklick",
  wheel: "Rad",
});

export const MODE_SOURCE_LABELS = Object.freeze({
  hybrid: "Hybrid",
  device: "Gerät",
  internal: "Intern",
});

const ERROR_MESSAGES = Object.freeze({
  not_found: "Diese Fernbedienung existiert nicht mehr.",
  invalid_format: "Die Anfrage wurde abgelehnt: ungültiges oder unbekanntes Feld.",
  invalid_sequence: "Die Aktionsfolge ist ungültig und wurde nicht gespeichert.",
  z2m_unavailable: "Zigbee2MQTT hat nicht rechtzeitig geantwortet.",
  already_configured: "Diese Fernbedienung ist bereits eingerichtet.",
  not_loaded: "Die BILRESA-Integration ist nicht eingerichtet oder wurde noch nicht geladen.",
  unknown_error: "Unerwarteter Fehler in der Integration.",
  not_connected: "Keine Verbindung zu Home Assistant.",
  unknown_command: "Der Befehl ist unbekannt — läuft eine ältere Version der Integration?",
  unknown: "Unerwarteter Fehler.",
});

/** Error with the contract's error code attached. */
export class BilresaError extends Error {
  constructor(code, message, raw) {
    super(message || ERROR_MESSAGES[code] || code || "unknown");
    this.name = "BilresaError";
    this.code = code || "unknown";
    this.raw = raw;
  }
}

/** Normalise anything a rejected websocket call can throw into a BilresaError. */
export function toError(err) {
  if (err instanceof BilresaError) return err;
  if (err && typeof err === "object") {
    const code = err.code || err.error?.code;
    const message = err.message || err.error?.message;
    if (code || message) return new BilresaError(code || "unknown", message, err);
  }
  if (err instanceof Error) return new BilresaError("unknown", err.message, err);
  return new BilresaError("unknown", err ? String(err) : undefined, err);
}

/** Human readable text for an error, suitable for a toast or an error card. */
export function describeError(err) {
  const error = toError(err);
  const base = ERROR_MESSAGES[error.code] || ERROR_MESSAGES.unknown;
  const detail = (error.message || "").trim();
  if (!detail || detail === error.code || detail === base) return base;
  return `${base} (${detail})`;
}

function requireConnection(hass) {
  if (!hass || !hass.connection) {
    throw new BilresaError("not_connected", ERROR_MESSAGES.not_connected);
  }
}

async function call(hass, message) {
  requireConnection(hass);
  try {
    return await hass.connection.sendMessagePromise(message);
  } catch (err) {
    throw toError(err);
  }
}

function requireId(subentryId) {
  if (typeof subentryId !== "string" || !subentryId) {
    throw new BilresaError("invalid_format", "Es wurde keine subentry_id übergeben.");
  }
  return subentryId;
}

/**
 * Binding commands accept either positional arguments or a single payload
 * object, so callers can use whichever reads better at the call site.
 */
function bindingPayload(subentryId, modeKey, action, extra) {
  const base =
    subentryId && typeof subentryId === "object"
      ? { ...subentryId }
      : { subentry_id: subentryId, mode_key: modeKey, action, ...(extra || {}) };
  requireId(base.subentry_id);
  if (typeof base.mode_key !== "string" || !base.mode_key) {
    throw new BilresaError("invalid_format", "mode_key fehlt.");
  }
  if (typeof base.action !== "string" || !base.action) {
    throw new BilresaError("invalid_format", "action fehlt.");
  }
  return base;
}

/* ------------------------------------------------------------ commands -- */

/** Read the whole configuration in one round trip. */
export function loadConfig(hass) {
  return call(hass, { type: WS.CONFIG });
}

/** List BILRESA remotes seen by Zigbee2MQTT. */
export function discover(hass, force = false) {
  return call(hass, { type: WS.DISCOVER, force: Boolean(force) });
}

/** Create a remote subentry. Only `ieee` is required. */
export function createRemote(hass, data) {
  const source = data && typeof data === "object" ? data : {};
  const message = { type: WS.REMOTE_CREATE };
  for (const field of CREATE_FIELDS) {
    const value = source[field];
    if (value !== undefined && value !== null && value !== "") message[field] = value;
  }
  if (typeof message.ieee !== "string" || !message.ieee) {
    throw new BilresaError("invalid_format", "Es wurde keine IEEE-Adresse übergeben.");
  }
  return call(hass, message);
}

/** Patch settings of an existing remote. `changes` is sent verbatim. */
export function updateRemote(hass, subentryId, changes) {
  requireId(subentryId);
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new BilresaError("invalid_format", "changes muss ein Objekt sein.");
  }
  if (Object.keys(changes).length === 0) {
    return Promise.resolve({ success: true });
  }
  return call(hass, {
    type: WS.REMOTE_UPDATE,
    subentry_id: subentryId,
    changes,
  });
}

/** Remove a remote subentry including all of its bindings. */
export function deleteRemote(hass, subentryId) {
  requireId(subentryId);
  return call(hass, { type: WS.REMOTE_DELETE, subentry_id: subentryId });
}

/**
 * Store a script sequence in one slot.
 * setBinding(hass, id, modeKey, action, sequence, scriptMode) or
 * setBinding(hass, { subentry_id, mode_key, action, sequence, script_mode }).
 */
export function setBinding(hass, subentryId, modeKey, action, sequence, scriptMode) {
  const payload = bindingPayload(subentryId, modeKey, action, {
    sequence,
    script_mode: scriptMode,
  });
  const message = {
    type: WS.BINDING_SET,
    subentry_id: payload.subentry_id,
    mode_key: payload.mode_key,
    action: payload.action,
    sequence: Array.isArray(payload.sequence) ? payload.sequence : [],
  };
  if (payload.script_mode) message.script_mode = payload.script_mode;
  return call(hass, message);
}

/** Empty one slot. */
export function clearBinding(hass, subentryId, modeKey, action) {
  const payload = bindingPayload(subentryId, modeKey, action);
  return call(hass, {
    type: WS.BINDING_CLEAR,
    subentry_id: payload.subentry_id,
    mode_key: payload.mode_key,
    action: payload.action,
  });
}

/** Run a stored binding once. */
export function testBinding(hass, subentryId, modeKey, action) {
  const payload = bindingPayload(subentryId, modeKey, action);
  return call(hass, {
    type: WS.BINDING_TEST,
    subentry_id: payload.subentry_id,
    mode_key: payload.mode_key,
    action: payload.action,
  });
}

/**
 * Subscribe to the normalised action stream.
 * Resolves to the unsubscribe function; a throwing callback never breaks the
 * subscription itself.
 */
export async function subscribeEvents(hass, callback) {
  requireConnection(hass);
  if (typeof callback !== "function") {
    throw new BilresaError("invalid_format", "subscribeEvents braucht eine Callback-Funktion.");
  }
  try {
    return await hass.connection.subscribeMessage(
      (event) => {
        try {
          callback(event);
        } catch (err) {
          // Never let a rendering error tear down the live subscription.
          console.error("[bilresa] event handler failed", err);
        }
      },
      { type: WS.SUBSCRIBE_EVENTS }
    );
  } catch (err) {
    throw toError(err);
  }
}

/* ------------------------------------------------------------- helpers -- */

/** Label for an internal action id, falling back to the raw value. */
export function formatAction(action) {
  return ACTION_LABELS[action] || action || "";
}

/** IEEE addresses are 0x + 16 hex digits; Z2M never emits anything else. */
export function isValidIeee(value) {
  return typeof value === "string" && /^0x[0-9a-f]{16}$/i.test(value.trim());
}

/** Normalise user input into the canonical lowercase form. */
export function normalizeIeee(value) {
  const raw = String(value ?? "").trim().replace(/\s+/g, "");
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  return `0x${hex.toLowerCase()}`;
}
