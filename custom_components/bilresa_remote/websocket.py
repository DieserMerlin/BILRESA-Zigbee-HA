"""WebSocket API between the BILRESA panel and the integration.

``ws_contract.md`` is the single source of truth for everything in this module:
command names, payload fields and error codes are taken from it literally.
Nothing may be added here that the contract does not list -- the panel is
written against the same document.

Design notes
------------
* Every command requires an admin connection. The panel edits the automation
  bindings of a physical remote; that is not something a guest user may do.
* Nothing here reloads the config entry on its own. Writing a subentry fires the
  config entry update listener in ``__init__``, which diffs and rebuilds only
  what changed -- a reload would tear down the MQTT subscriptions and every
  entity of every remote.
* No handler may raise. A broken request costs the caller one error message with
  a contract error code, never an exception traceback in the frontend.
"""

from __future__ import annotations

import copy
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from functools import wraps
from inspect import isawaitable, signature
from types import MappingProxyType
from typing import Any, Final

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry, ConfigEntryState, ConfigSubentry
from homeassistant.core import Context, HomeAssistant, callback
from homeassistant.data_entry_flow import AbortFlow
from homeassistant.exceptions import HomeAssistantError, Unauthorized
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.script import (
    SCRIPT_MODE_CHOICES,
    SCRIPT_MODE_RESTART,
    SCRIPT_MODE_SINGLE,
    Script,
    async_validate_actions_config,
)
from homeassistant.util import dt as dt_util
from homeassistant.util.ulid import ulid_now

from .const import (
    ACTION_TRIPLE,
    ACTION_WHEEL,
    ACTIONS_WITHOUT_MODE,
    ATTR_ACTION,
    ATTR_ACTION_GROUP,
    ATTR_DELTA,
    ATTR_DIRECTION,
    ATTR_LEVEL,
    ATTR_LEVEL_254,
    ATTR_LEVEL_PCT,
    ATTR_MODE,
    ATTR_MODE_NAME,
    ATTR_MODE_SOURCE,
    ATTR_PREVIOUS_LEVEL,
    ATTR_REMOTE_ID,
    BINDABLE_ACTIONS,
    COLORS,
    CONF_BASE_TOPIC,
    CONF_COLOR,
    CONF_GROUP_IDS,
    CONF_IEEE,
    CONF_MAPPINGS,
    CONF_MODE_COUNT,
    CONF_MODE_CYCLE_ACTION,
    CONF_MODE_NAMES,
    CONF_MODE_SOURCE,
    CONF_MODELESS_MULTICLICK,
    CONF_NAME,
    CONF_SCRIPT_MODE,
    CONF_SEQUENCE,
    CONF_SPLIT_SINGLE_CLICK,
    CONF_WHEEL_THROTTLE_MS,
    DEFAULT_BASE_TOPIC,
    DEFAULT_COLOR,
    DEFAULT_GROUP_IDS,
    DEFAULT_MODE_COUNT,
    DEFAULT_MODE_SOURCE,
    DEFAULT_MODELESS_MULTICLICK,
    DEFAULT_SPLIT_SINGLE_CLICK,
    DEFAULT_WHEEL_THROTTLE_MS,
    DOMAIN,
    MODE_SOURCES,
    SIGNAL_ACTION,
    SUBENTRY_TYPE_REMOTE,
    WHEEL_LEVEL_MAX,
)
from .dispatcher import (
    MODELESS_MODE_KEY,
    _unpack_binding,
    async_current_mode,
    async_get_remote_runtime,
    event_remote_id,
    event_value,
    mode_label,
    mode_names,
    modeless_multiclick,
    remote_ieee,
    remote_name,
    remote_subentries,
    resolve_action,
)
from .mode import CONF_MODE_CYCLE_WRAP, DEFAULT_MODE_CYCLE_WRAP, MAX_MODE_COUNT, ModeConfig
from .z2m import Z2MError, Z2MRemote, async_discover_remotes

_LOGGER = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Contract constants
# --------------------------------------------------------------------------- #

WS_CONFIG: Final = f"{DOMAIN}/config"
WS_DISCOVER: Final = f"{DOMAIN}/discover"
WS_REMOTE_CREATE: Final = f"{DOMAIN}/remote/create"
WS_REMOTE_UPDATE: Final = f"{DOMAIN}/remote/update"
WS_REMOTE_DELETE: Final = f"{DOMAIN}/remote/delete"
WS_BINDING_SET: Final = f"{DOMAIN}/binding/set"
WS_BINDING_CLEAR: Final = f"{DOMAIN}/binding/clear"
WS_BINDING_TEST: Final = f"{DOMAIN}/binding/test"
WS_SUBSCRIBE_EVENTS: Final = f"{DOMAIN}/subscribe_events"

#: Error codes of the contract. ``not_found`` / ``invalid_format`` are the core
#: websocket codes; they are spelled out here so the contract stays readable
#: without chasing Home Assistant internals.
ERR_NOT_FOUND: Final = "not_found"
ERR_INVALID_FORMAT: Final = "invalid_format"
ERR_INVALID_SEQUENCE: Final = "invalid_sequence"
ERR_ALREADY_CONFIGURED: Final = "already_configured"
#: Reserved by the contract. ``discover`` deliberately does not fail with it:
#: it answers with ``z2m_available: false`` (and the last known device list), so
#: the panel can show the state instead of an error dialog.
ERR_Z2M_UNAVAILABLE: Final = "z2m_unavailable"
#: Not part of the contract table: core codes for "integration not set up" and
#: for the last-resort catch-all, so a failure is never an exception on the wire.
ERR_NOT_LOADED: Final = "not_loaded"
ERR_UNKNOWN: Final = "unknown_error"

#: Mirrors ``__init__.CONF_SCHEMA_VERSION`` / ``SUBENTRY_SCHEMA_VERSION``.
#: Duplicated (as in ``config_flow``) so this module never imports the package
#: module that imports it.
CONF_SCHEMA_VERSION: Final = "schema_version"
SCHEMA_VERSION: Final = 1

#: Legacy container name for the per-mode bindings.
_LEGACY_MAPPINGS_KEY: Final = "modes"

_DATA_REGISTERED: Final = f"{DOMAIN}_websocket_registered"
_DATA_DISCOVERY: Final = f"{DOMAIN}_discovery_cache"

#: How long a Zigbee2MQTT device list stays usable without asking again.
_DISCOVERY_TTL: Final = 30.0

#: ``bridge/devices`` is retained, so it arrives at once when Z2M is running.
#: The timeout only matters when it is not -- keep it short for ``config``,
#: which the panel calls on every open.
_DISCOVERY_TIMEOUT: Final = 8.0
_CONFIG_DISCOVERY_TIMEOUT: Final = 4.0

#: Fallback wheel level used by ``binding/test`` when the remote never reported
#: one (mid scale, so a light does something visible).
_TEST_WHEEL_LEVEL: Final = 128

#: ZCL allows 255, light entities cap at 254 (same value as in ``coordinator``).
_LEVEL_MAX_FOR_LIGHTS: Final = 254


# --------------------------------------------------------------------------- #
# Registration
# --------------------------------------------------------------------------- #


@callback
def async_register_websocket_api(hass: HomeAssistant) -> None:
    """Register every panel command exactly once per process."""
    if hass.data.get(_DATA_REGISTERED):
        return
    hass.data[_DATA_REGISTERED] = True

    for handler in _COMMANDS:
        websocket_api.async_register_command(hass, handler)

    _LOGGER.debug("Registered %s panel websocket commands", len(_COMMANDS))


def _guarded(func: Any) -> Any:
    """Turn any unexpected failure into a websocket error message.

    The core already catches exceptions from a command handler, but it answers
    with a generic message. Doing it here keeps the cause visible in the panel
    and guarantees the contract promise that no handler ever raises.
    """

    @wraps(func)
    async def wrapper(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        """Run the wrapped handler, answering with an error if it blows up."""
        try:
            await func(hass, connection, msg)
        except Unauthorized:
            raise
        except Exception as err:
            # Deliberate catch-all: a panel request must never end as a traceback.
            _LOGGER.exception("Panel command %s failed", msg.get("type"))
            connection.send_error(msg["id"], ERR_UNKNOWN, str(err) or type(err).__name__)

    return wrapper


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _as_int(value: Any, default: int | None = None) -> int | None:
    """Best effort int conversion that never raises."""
    if isinstance(value, bool) or value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


@callback
def _async_entry(hass: HomeAssistant) -> ConfigEntry | None:
    """Return the config entry of the integration, preferring a loaded one."""
    entries = hass.config_entries.async_entries(DOMAIN)
    for entry in entries:
        if entry.state is ConfigEntryState.LOADED:
            return entry
    return entries[0] if entries else None


@callback
def _async_require_entry(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> ConfigEntry | None:
    """Return the config entry, answering with an error when there is none."""
    entry = _async_entry(hass)
    if entry is None:
        connection.send_error(
            msg["id"], ERR_NOT_LOADED, "The BILRESA Remote integration is not set up"
        )
        return None
    return entry


@callback
def _async_require_subentry(
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    entry: ConfigEntry,
) -> ConfigSubentry | None:
    """Return the addressed remote subentry, or answer with ``not_found``."""
    subentry_id = str(msg.get("subentry_id") or "")
    subentry = entry.subentries.get(subentry_id)
    if subentry is None or subentry.subentry_type != SUBENTRY_TYPE_REMOTE:
        connection.send_error(msg["id"], ERR_NOT_FOUND, f"Unknown remote {subentry_id}")
        return None
    return subentry


def _base_topic(entry: ConfigEntry) -> str:
    """Return the Zigbee2MQTT base topic, options winning over data."""
    raw = entry.options.get(CONF_BASE_TOPIC) or entry.data.get(CONF_BASE_TOPIC)
    return str(raw or DEFAULT_BASE_TOPIC).strip().strip("/") or DEFAULT_BASE_TOPIC


@callback
def _raw_mappings(subentry: ConfigSubentry) -> dict[str, Any]:
    """Return the stored bindings container of a remote as a plain dict."""
    raw = subentry.data.get(CONF_MAPPINGS)
    if not isinstance(raw, Mapping):
        raw = subentry.data.get(_LEGACY_MAPPINGS_KEY)
    if not isinstance(raw, Mapping):
        return {}
    return {str(key): dict(value) for key, value in raw.items() if isinstance(value, Mapping)}


def _mode_count(subentry: ConfigSubentry) -> int:
    """Return the configured number of modes, sanitised."""
    count = _as_int(subentry.data.get(CONF_MODE_COUNT), DEFAULT_MODE_COUNT) or DEFAULT_MODE_COUNT
    return max(1, min(count, MAX_MODE_COUNT))


def _normalise_mode_key(raw: Any, count: int) -> str | None:
    """Return a usable mode key (``"*"`` or ``"1".."n"``), or None."""
    key = str(raw or "").strip()
    if key == MODELESS_MODE_KEY:
        return key
    mode = _as_int(key)
    if mode is None or not 1 <= mode <= count:
        return None
    return str(mode)


def _padded_mode_names(names: Any, count: int) -> list[str]:
    """Return at least ``count`` mode names, filling gaps with defaults.

    Names of modes beyond the current count are kept: lowering ``mode_count``
    and raising it again must not silently forget what the user typed.
    """
    if isinstance(names, str) or not isinstance(names, (list, tuple)):
        names = []
    result: list[str] = []
    for index in range(count):
        candidate = names[index] if index < len(names) else None
        label = str(candidate).strip() if candidate not in (None, "") else ""
        result.append(label or f"Mode {index + 1}")
    # Never drop names the user typed for modes they may re-enable later.
    result.extend(str(name) for name in list(names)[count:])
    return result


# --------------------------------------------------------------------------- #
# Subentry persistence
#
# ``async_add_subentry`` / ``async_update_subentry`` / ``async_remove_subentry``
# exist since Home Assistant 2025.2. Every one of them is checked at runtime and
# has a fallback that rebuilds the whole subentry mapping through
# ``async_update_entry``, so a future signature change degrades instead of
# breaking the panel.
# --------------------------------------------------------------------------- #


def _supports_subentries_kwarg(hass: HomeAssistant) -> bool:
    """Return whether ``async_update_entry`` accepts a ``subentries`` mapping."""
    try:
        parameters = signature(hass.config_entries.async_update_entry).parameters
    except (TypeError, ValueError):
        return False
    return "subentries" in parameters


def _replace_subentries(
    hass: HomeAssistant, entry: ConfigEntry, subentries: dict[str, ConfigSubentry]
) -> None:
    """Write a complete subentry mapping through ``async_update_entry``."""
    if not _supports_subentries_kwarg(hass):
        raise HomeAssistantError(
            "This Home Assistant version cannot store config subentries from the panel"
        )
    hass.config_entries.async_update_entry(entry, subentries=subentries)


async def _async_store_subentry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    subentry: ConfigSubentry,
    *,
    data: Mapping[str, Any] | None = None,
    title: str | None = None,
) -> None:
    """Persist changed data and/or title of one remote subentry."""
    update = getattr(hass.config_entries, "async_update_subentry", None)
    if callable(update):
        kwargs: dict[str, Any] = {}
        if data is not None:
            kwargs["data"] = dict(data)
        if title is not None:
            kwargs["title"] = title
        result = update(entry, subentry, **kwargs)
        if isawaitable(result):
            await result
        return

    subentries = dict(entry.subentries)
    subentries[subentry.subentry_id] = ConfigSubentry(
        data=MappingProxyType(dict(data if data is not None else subentry.data)),
        subentry_id=subentry.subentry_id,
        subentry_type=subentry.subentry_type,
        title=title if title is not None else subentry.title,
        unique_id=subentry.unique_id,
    )
    _replace_subentries(hass, entry, subentries)


async def _async_add_subentry(
    hass: HomeAssistant, entry: ConfigEntry, subentry: ConfigSubentry
) -> None:
    """Add a new remote subentry to the config entry."""
    add = getattr(hass.config_entries, "async_add_subentry", None)
    if callable(add):
        result = add(entry, subentry)
        if isawaitable(result):
            await result
        return

    subentries = dict(entry.subentries)
    subentries[subentry.subentry_id] = subentry
    _replace_subentries(hass, entry, subentries)


async def _async_remove_subentry(hass: HomeAssistant, entry: ConfigEntry, subentry_id: str) -> None:
    """Remove a remote subentry and everything attached to it."""
    remove = getattr(hass.config_entries, "async_remove_subentry", None)
    if callable(remove):
        result = remove(entry, subentry_id)
        if isawaitable(result):
            await result
        return

    subentries = dict(entry.subentries)
    subentries.pop(subentry_id, None)
    _replace_subentries(hass, entry, subentries)


# --------------------------------------------------------------------------- #
# Zigbee2MQTT discovery cache
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class _Discovery:
    """Cached result of one ``bridge/devices`` read."""

    remotes: tuple[Z2MRemote, ...]
    available: bool
    at: float


async def _async_discovery(
    hass: HomeAssistant,
    base_topic: str,
    *,
    force: bool = False,
    timeout: float = _DISCOVERY_TIMEOUT,
) -> _Discovery:
    """Return the BILRESA remotes known to Zigbee2MQTT.

    Never raises: when Zigbee2MQTT cannot be reached the last known list is
    returned with ``available=False``, so the panel can say so instead of
    showing an empty page.
    """
    cached = hass.data.get(_DATA_DISCOVERY)
    now = time.monotonic()
    if (
        not force
        and isinstance(cached, _Discovery)
        and cached.available
        and now - cached.at < _DISCOVERY_TTL
    ):
        return cached

    try:
        remotes = await async_discover_remotes(hass, base_topic, timeout=timeout)
    except Z2MError as err:
        _LOGGER.debug("Zigbee2MQTT discovery failed: %s", err)
        if isinstance(cached, _Discovery):
            return _Discovery(cached.remotes, False, cached.at)
        return _Discovery((), False, now)
    except Exception:
        _LOGGER.exception("Unexpected error while reading the Zigbee2MQTT device list")
        if isinstance(cached, _Discovery):
            return _Discovery(cached.remotes, False, cached.at)
        return _Discovery((), False, now)

    discovery = _Discovery(tuple(remotes), True, now)
    hass.data[_DATA_DISCOVERY] = discovery
    return discovery


def _device_label(remote: Z2MRemote) -> str:
    """Return the label shown in the device picker."""
    parts: list[str] = []
    if remote.description:
        parts.append(f"{remote.description} - {remote.ieee}")
    elif remote.friendly_name and remote.friendly_name != remote.ieee:
        parts.append(f"{remote.friendly_name} - {remote.ieee}")
    else:
        parts.append(remote.ieee)
    if remote.model:
        parts.append(f"({remote.model})")
    return " ".join(parts)


# --------------------------------------------------------------------------- #
# Payload builders
# --------------------------------------------------------------------------- #


@callback
def _bindings_payload(subentry: ConfigSubentry) -> dict[str, dict[str, dict[str, Any]]]:
    """Return the stored bindings in the shape the contract defines."""
    payload: dict[str, dict[str, dict[str, Any]]] = {}
    for mode_key, bindings in _raw_mappings(subentry).items():
        slot: dict[str, dict[str, Any]] = {}
        for action, raw in bindings.items():
            if action not in BINDABLE_ACTIONS:
                continue
            sequence, script_mode, _throttle = _unpack_binding(raw)
            if not sequence:
                continue
            slot[str(action)] = {
                CONF_SEQUENCE: sequence,
                CONF_SCRIPT_MODE: _sanitised_script_mode(script_mode, str(action)),
            }
        if slot:
            payload[mode_key] = slot
    return payload


def _sanitised_script_mode(script_mode: Any, action: str) -> str:
    """Return a usable script mode, mirroring what the dispatcher picks."""
    if script_mode in SCRIPT_MODE_CHOICES:
        return str(script_mode)
    # Absolute wheel values: a newer value fully replaces the older one.
    return SCRIPT_MODE_RESTART if action == ACTION_WHEEL else SCRIPT_MODE_SINGLE


@callback
def _remote_payload(
    entry: ConfigEntry, subentry: ConfigSubentry, *, available: bool
) -> dict[str, Any]:
    """Return one remote in the shape the contract defines."""
    data = subentry.data
    mode_config = ModeConfig.from_data(data)

    color = data.get(CONF_COLOR)
    if color not in COLORS:
        color = DEFAULT_COLOR

    throttle = _as_int(data.get(CONF_WHEEL_THROTTLE_MS), DEFAULT_WHEEL_THROTTLE_MS)
    if throttle is None or throttle < 0:
        throttle = DEFAULT_WHEEL_THROTTLE_MS

    runtime = async_get_remote_runtime(entry, subentry.subentry_id)
    resolver = getattr(runtime, "mode", None)
    effective_source = getattr(resolver, "mode_source", None) or mode_config.source
    current_mode = async_current_mode(entry, subentry.subentry_id) or 1

    return {
        "subentry_id": subentry.subentry_id,
        CONF_IEEE: remote_ieee(subentry),
        CONF_NAME: remote_name(subentry),
        CONF_COLOR: color,
        CONF_MODE_SOURCE: mode_config.source,
        "effective_mode_source": str(effective_source),
        CONF_MODE_COUNT: mode_config.count,
        CONF_MODE_NAMES: mode_names(subentry),
        CONF_MODELESS_MULTICLICK: modeless_multiclick(subentry),
        CONF_SPLIT_SINGLE_CLICK: bool(
            data.get(CONF_SPLIT_SINGLE_CLICK, DEFAULT_SPLIT_SINGLE_CLICK)
        ),
        CONF_WHEEL_THROTTLE_MS: throttle,
        CONF_MODE_CYCLE_ACTION: mode_config.cycle_action,
        CONF_MODE_CYCLE_WRAP: mode_config.cycle_wrap,
        CONF_GROUP_IDS: list(mode_config.group_ids),
        "current_mode": min(max(current_mode, 1), mode_config.count),
        "available": available,
        "bindings": _bindings_payload(subentry),
    }


# --------------------------------------------------------------------------- #
# bilresa_remote/config
# --------------------------------------------------------------------------- #


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): WS_CONFIG})
@websocket_api.async_response
@_guarded
async def websocket_config(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the whole configuration in one round trip."""
    entry = _async_require_entry(hass, connection, msg)
    if entry is None:
        return

    base_topic = _base_topic(entry)
    discovery = await _async_discovery(hass, base_topic, timeout=_CONFIG_DISCOVERY_TIMEOUT)
    seen = {remote.ieee for remote in discovery.remotes}

    remotes = [
        _remote_payload(
            entry,
            subentry,
            # Absence can only be proven while Zigbee2MQTT actually answers.
            available=(remote_ieee(subentry) in seen) if discovery.available else True,
        )
        for subentry in remote_subentries(entry)
    ]

    connection.send_result(
        msg["id"],
        {
            CONF_BASE_TOPIC: base_topic,
            "colors": list(COLORS),
            "actions": list(BINDABLE_ACTIONS),
            "mode_sources": list(MODE_SOURCES),
            "modeless_key": MODELESS_MODE_KEY,
            "remotes": remotes,
        },
    )


# --------------------------------------------------------------------------- #
# bilresa_remote/discover
# --------------------------------------------------------------------------- #


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_DISCOVER,
        vol.Optional("force", default=False): cv.boolean,
    }
)
@websocket_api.async_response
@_guarded
async def websocket_discover(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """List the BILRESA remotes Zigbee2MQTT knows about."""
    entry = _async_require_entry(hass, connection, msg)
    if entry is None:
        return

    discovery = await _async_discovery(hass, _base_topic(entry), force=bool(msg.get("force")))
    configured = {remote_ieee(subentry) for subentry in remote_subentries(entry)}

    connection.send_result(
        msg["id"],
        {
            "devices": [
                {
                    CONF_IEEE: remote.ieee,
                    "friendly_name": remote.friendly_name,
                    "comment": remote.description,
                    "model": remote.model,
                    "label": _device_label(remote),
                    "suggested_color": remote.suggested_color,
                    "configured": remote.ieee in configured,
                }
                for remote in discovery.remotes
            ],
            "z2m_available": discovery.available,
        },
    )


# --------------------------------------------------------------------------- #
# bilresa_remote/remote/create
# --------------------------------------------------------------------------- #

#: Characters that would break the MQTT topic built from the address.
_BAD_IEEE: Final = ("#", "+", "/", " ", "\t", "\n")


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_REMOTE_CREATE,
        vol.Required(CONF_IEEE): cv.string,
        vol.Optional(CONF_NAME): cv.string,
        vol.Optional(CONF_COLOR): vol.In(COLORS),
        vol.Optional(CONF_MODE_SOURCE): vol.In(MODE_SOURCES),
        vol.Optional(CONF_MODE_COUNT): vol.All(vol.Coerce(int), vol.Range(1, MAX_MODE_COUNT)),
        vol.Optional(CONF_MODE_NAMES): [cv.string],
        vol.Optional(CONF_MODELESS_MULTICLICK): cv.boolean,
    }
)
@websocket_api.async_response
@_guarded
async def websocket_remote_create(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Add a remote. Everything but the address falls back to a default."""
    entry = _async_require_entry(hass, connection, msg)
    if entry is None:
        return

    ieee = str(msg[CONF_IEEE]).strip()
    if not ieee or any(char in ieee for char in _BAD_IEEE):
        connection.send_error(
            msg["id"],
            ERR_INVALID_FORMAT,
            "The address must not be empty and must not contain spaces, slashes or "
            "the MQTT wildcards + and #",
        )
        return

    for subentry in remote_subentries(entry):
        if remote_ieee(subentry) == ieee:
            connection.send_error(msg["id"], ERR_ALREADY_CONFIGURED, f"{ieee} is already set up")
            return

    count = int(msg.get(CONF_MODE_COUNT, DEFAULT_MODE_COUNT))
    name = str(msg.get(CONF_NAME) or "").strip() or ieee

    data: dict[str, Any] = {
        CONF_IEEE: ieee,
        CONF_NAME: name,
        CONF_COLOR: msg.get(CONF_COLOR, DEFAULT_COLOR),
        CONF_MODE_SOURCE: msg.get(CONF_MODE_SOURCE, DEFAULT_MODE_SOURCE),
        CONF_MODE_COUNT: count,
        CONF_MODE_NAMES: _padded_mode_names(msg.get(CONF_MODE_NAMES), count),
        CONF_MODELESS_MULTICLICK: bool(
            msg.get(CONF_MODELESS_MULTICLICK, DEFAULT_MODELESS_MULTICLICK)
        ),
        CONF_SPLIT_SINGLE_CLICK: DEFAULT_SPLIT_SINGLE_CLICK,
        CONF_WHEEL_THROTTLE_MS: DEFAULT_WHEEL_THROTTLE_MS,
        CONF_MODE_CYCLE_ACTION: ACTION_TRIPLE,
        CONF_MODE_CYCLE_WRAP: DEFAULT_MODE_CYCLE_WRAP,
        CONF_GROUP_IDS: list(DEFAULT_GROUP_IDS),
        CONF_MAPPINGS: {},
        CONF_SCHEMA_VERSION: SCHEMA_VERSION,
    }

    fields: dict[str, Any] = {
        "data": MappingProxyType(data),
        "subentry_type": SUBENTRY_TYPE_REMOTE,
        "title": name,
        "unique_id": ieee,
    }
    try:
        subentry = ConfigSubentry(**fields)
    except TypeError:
        # Defensive: the id has a default factory today, but generating one
        # ourselves keeps the panel working if that ever changes.
        subentry = ConfigSubentry(subentry_id=ulid_now(), **fields)

    try:
        await _async_add_subentry(hass, entry, subentry)
    except AbortFlow as err:
        # Core rejects a duplicate unique id this way.
        connection.send_error(msg["id"], ERR_ALREADY_CONFIGURED, str(err))
        return
    except (HomeAssistantError, ValueError) as err:
        connection.send_error(msg["id"], ERR_UNKNOWN, str(err))
        return

    _LOGGER.debug("Panel added remote %s (%s)", name, ieee)
    connection.send_result(msg["id"], {"subentry_id": subentry.subentry_id})


# --------------------------------------------------------------------------- #
# bilresa_remote/remote/update
# --------------------------------------------------------------------------- #

#: Exactly the settings fields of the ``config`` response. Anything else is
#: rejected with ``invalid_format`` by voluptuous.
_CHANGES_SCHEMA: Final = vol.Schema(
    {
        vol.Optional(CONF_NAME): cv.string,
        vol.Optional(CONF_COLOR): vol.In(COLORS),
        vol.Optional(CONF_MODE_SOURCE): vol.In(MODE_SOURCES),
        vol.Optional(CONF_MODE_COUNT): vol.All(vol.Coerce(int), vol.Range(1, MAX_MODE_COUNT)),
        vol.Optional(CONF_MODE_NAMES): [cv.string],
        vol.Optional(CONF_MODELESS_MULTICLICK): cv.boolean,
        vol.Optional(CONF_SPLIT_SINGLE_CLICK): cv.boolean,
        vol.Optional(CONF_WHEEL_THROTTLE_MS): vol.All(vol.Coerce(int), vol.Range(0, 10_000)),
        vol.Optional(CONF_MODE_CYCLE_ACTION): vol.In(BINDABLE_ACTIONS),
        vol.Optional(CONF_MODE_CYCLE_WRAP): cv.boolean,
        vol.Optional(CONF_GROUP_IDS): [vol.All(vol.Coerce(int), vol.Range(0, 0xFFFF))],
    }
)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_REMOTE_UPDATE,
        vol.Required("subentry_id"): cv.string,
        vol.Required("changes"): _CHANGES_SCHEMA,
    }
)
@websocket_api.async_response
@_guarded
async def websocket_remote_update(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Apply a partial settings change to one remote."""
    entry = _async_require_entry(hass, connection, msg)
    if entry is None:
        return
    subentry = _async_require_subentry(connection, msg, entry)
    if subentry is None:
        return

    changes: dict[str, Any] = dict(msg["changes"])
    if not changes:
        connection.send_result(msg["id"], {"success": True})
        return

    data = dict(subentry.data)
    title = subentry.title

    if CONF_NAME in changes:
        name = str(changes[CONF_NAME]).strip()
        if not name:
            connection.send_error(msg["id"], ERR_INVALID_FORMAT, "The name must not be empty")
            return
        data[CONF_NAME] = name
        title = name

    for key in (
        CONF_COLOR,
        CONF_MODE_SOURCE,
        CONF_MODELESS_MULTICLICK,
        CONF_SPLIT_SINGLE_CLICK,
        CONF_WHEEL_THROTTLE_MS,
        CONF_MODE_CYCLE_ACTION,
        CONF_MODE_CYCLE_WRAP,
    ):
        if key in changes:
            data[key] = changes[key]

    if CONF_GROUP_IDS in changes:
        groups = list(changes[CONF_GROUP_IDS])
        if not groups:
            connection.send_error(
                msg["id"], ERR_INVALID_FORMAT, "At least one group id is required"
            )
            return
        data[CONF_GROUP_IDS] = groups

    # Names and count belong together: a changed count must never leave the
    # remote with fewer names than modes.
    count = int(changes.get(CONF_MODE_COUNT, data.get(CONF_MODE_COUNT, DEFAULT_MODE_COUNT)))
    count = max(1, min(count, MAX_MODE_COUNT))
    names = changes.get(CONF_MODE_NAMES, data.get(CONF_MODE_NAMES))
    if CONF_MODE_COUNT in changes or CONF_MODE_NAMES in changes:
        data[CONF_MODE_COUNT] = count
        data[CONF_MODE_NAMES] = _padded_mode_names(names, count)

    data[CONF_SCHEMA_VERSION] = SCHEMA_VERSION

    try:
        await _async_store_subentry(hass, entry, subentry, data=data, title=title)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], ERR_UNKNOWN, str(err))
        return

    connection.send_result(msg["id"], {"success": True})


# --------------------------------------------------------------------------- #
# bilresa_remote/remote/delete
# --------------------------------------------------------------------------- #


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_REMOTE_DELETE,
        vol.Required("subentry_id"): cv.string,
    }
)
@websocket_api.async_response
@_guarded
async def websocket_remote_delete(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Delete a remote together with its devices and entities."""
    entry = _async_require_entry(hass, connection, msg)
    if entry is None:
        return
    subentry = _async_require_subentry(connection, msg, entry)
    if subentry is None:
        return

    try:
        await _async_remove_subentry(hass, entry, subentry.subentry_id)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], ERR_UNKNOWN, str(err))
        return

    _LOGGER.debug("Panel removed remote %s", subentry.title)
    connection.send_result(msg["id"], {"success": True})


# --------------------------------------------------------------------------- #
# bilresa_remote/binding/*
# --------------------------------------------------------------------------- #

_INVALID_SEQUENCE_MESSAGE: Final = "The action sequence is not valid"


async def _async_validate_sequence(
    hass: HomeAssistant, sequence: list[Any]
) -> tuple[list[Any] | None, str]:
    """Validate an action sequence.

    Returns ``(validated, "")`` or ``(None, message)``. The *validated* config
    is only usable for running a script -- it contains ``Template`` objects and
    must never be written to a config entry.
    """
    try:
        config = cv.SCRIPT_SCHEMA(copy.deepcopy(sequence))
        validated = await async_validate_actions_config(hass, config)
    except (vol.Invalid, HomeAssistantError) as err:
        return None, str(err) or _INVALID_SEQUENCE_MESSAGE
    except Exception as err:
        # The action editor is a pure pass-through, so anything can arrive here.
        _LOGGER.debug("Unexpected error validating a sequence", exc_info=True)
        return None, str(err) or type(err).__name__
    return list(validated), ""


@callback
def _binding_slot(
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    subentry: ConfigSubentry,
    *,
    limit: int,
) -> tuple[str, str] | None:
    """Return the validated ``(mode_key, action)`` addressed by a request.

    ``limit`` is the highest mode a request may address. Storing a binding is
    restricted to the modes the remote actually has, while clearing and testing
    accept any mode key so a binding left over from a higher ``mode_count`` can
    still be reached.
    """
    mode_key = _normalise_mode_key(msg.get("mode_key"), limit)
    if mode_key is None:
        connection.send_error(
            msg["id"],
            ERR_INVALID_FORMAT,
            f"mode_key must be {MODELESS_MODE_KEY!r} or a mode between 1 and {limit}",
        )
        return None
    return mode_key, str(msg["action"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_BINDING_SET,
        vol.Required("subentry_id"): cv.string,
        vol.Required("mode_key"): cv.string,
        vol.Required("action"): vol.In(BINDABLE_ACTIONS),
        vol.Required(CONF_SEQUENCE): vol.Any(list, dict),
        vol.Optional(CONF_SCRIPT_MODE): vol.In(SCRIPT_MODE_CHOICES),
    }
)
@websocket_api.async_response
@_guarded
async def websocket_binding_set(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Store one action binding after validating its sequence."""
    entry = _async_require_entry(hass, connection, msg)
    if entry is None:
        return
    subentry = _async_require_subentry(connection, msg, entry)
    if subentry is None:
        return
    slot = _binding_slot(connection, msg, subentry, limit=_mode_count(subentry))
    if slot is None:
        return
    mode_key, action = slot

    raw_sequence = msg[CONF_SEQUENCE]
    sequence = [dict(raw_sequence)] if isinstance(raw_sequence, dict) else list(raw_sequence)

    mappings = _raw_mappings(subentry)
    bindings = dict(mappings.get(mode_key, {}))

    if not sequence:
        # An empty sequence is the same request as binding/clear.
        bindings.pop(action, None)
    else:
        validated, message = await _async_validate_sequence(hass, sequence)
        if validated is None:
            connection.send_error(
                msg["id"], ERR_INVALID_SEQUENCE, message or _INVALID_SEQUENCE_MESSAGE
            )
            return

        # Keep the per-slot options of the existing binding (the panel does not
        # edit the wheel throttle) and store the *original* sequence: the
        # validated one carries Template objects and is not serialisable.
        existing = bindings.get(action)
        binding: dict[str, Any] = {}
        if isinstance(existing, Mapping):
            binding = {
                key: existing[key]
                for key in (CONF_SCRIPT_MODE, CONF_WHEEL_THROTTLE_MS)
                if existing.get(key) is not None
            }
        binding[CONF_SEQUENCE] = sequence
        binding[CONF_SCRIPT_MODE] = _sanitised_script_mode(
            msg.get(CONF_SCRIPT_MODE, binding.get(CONF_SCRIPT_MODE)), action
        )
        bindings[action] = binding

    if bindings:
        mappings[mode_key] = bindings
    else:
        mappings.pop(mode_key, None)

    data = dict(subentry.data)
    data[CONF_MAPPINGS] = mappings
    data.pop(_LEGACY_MAPPINGS_KEY, None)
    data[CONF_SCHEMA_VERSION] = SCHEMA_VERSION

    try:
        await _async_store_subentry(hass, entry, subentry, data=data)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], ERR_UNKNOWN, str(err))
        return

    connection.send_result(msg["id"], {"success": True})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_BINDING_CLEAR,
        vol.Required("subentry_id"): cv.string,
        vol.Required("mode_key"): cv.string,
        vol.Required("action"): vol.In(BINDABLE_ACTIONS),
    }
)
@websocket_api.async_response
@_guarded
async def websocket_binding_clear(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Remove one action binding. Clearing an empty slot is not an error."""
    entry = _async_require_entry(hass, connection, msg)
    if entry is None:
        return
    subentry = _async_require_subentry(connection, msg, entry)
    if subentry is None:
        return
    slot = _binding_slot(connection, msg, subentry, limit=MAX_MODE_COUNT)
    if slot is None:
        return
    mode_key, action = slot

    mappings = _raw_mappings(subentry)
    bindings = dict(mappings.get(mode_key, {}))
    if action in bindings:
        bindings.pop(action, None)
        if bindings:
            mappings[mode_key] = bindings
        else:
            mappings.pop(mode_key, None)

        data = dict(subentry.data)
        data[CONF_MAPPINGS] = mappings
        data.pop(_LEGACY_MAPPINGS_KEY, None)
        data[CONF_SCHEMA_VERSION] = SCHEMA_VERSION
        try:
            await _async_store_subentry(hass, entry, subentry, data=data)
        except HomeAssistantError as err:
            connection.send_error(msg["id"], ERR_UNKNOWN, str(err))
            return

    connection.send_result(msg["id"], {"success": True})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_BINDING_TEST,
        vol.Required("subentry_id"): cv.string,
        vol.Required("mode_key"): cv.string,
        vol.Required("action"): vol.In(BINDABLE_ACTIONS),
    }
)
@websocket_api.async_response
@_guarded
async def websocket_binding_test(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Run the stored script of one binding once.

    The run itself happens in the background, exactly like a real button press:
    a sequence with a delay in it must not keep the command open.
    """
    entry = _async_require_entry(hass, connection, msg)
    if entry is None:
        return
    subentry = _async_require_subentry(connection, msg, entry)
    if subentry is None:
        return
    slot = _binding_slot(connection, msg, subentry, limit=MAX_MODE_COUNT)
    if slot is None:
        return
    mode_key, action = slot

    raw = _raw_mappings(subentry).get(mode_key, {}).get(action)
    sequence, script_mode, _throttle = _unpack_binding(raw)
    if not sequence:
        connection.send_error(
            msg["id"],
            ERR_NOT_FOUND,
            f"No binding stored for {action} in mode {mode_key}",
        )
        return

    validated, message = await _async_validate_sequence(hass, sequence)
    if validated is None:
        connection.send_error(msg["id"], ERR_INVALID_SEQUENCE, message or _INVALID_SEQUENCE_MESSAGE)
        return

    label = "all modes" if mode_key == MODELESS_MODE_KEY else f"mode {mode_key}"
    name = f"{remote_name(subentry)} {label} {action}"
    script = Script(
        hass,
        validated,
        name,
        DOMAIN,
        logger=_LOGGER,
        running_description=f"{name} test",
        script_mode=_sanitised_script_mode(script_mode, action),
    )

    variables = _test_variables(entry, subentry, mode_key, action)
    entry.async_create_background_task(
        hass,
        _async_run_test(script, variables),
        f"{DOMAIN}_test_{subentry.subentry_id}_{mode_key}_{action}",
        eager_start=True,
    )

    connection.send_result(msg["id"], {"success": True})


async def _async_run_test(script: Script, variables: dict[str, Any]) -> None:
    """Run a test script, swallowing failures so nothing else is affected."""
    try:
        await script.async_run(run_variables=variables, context=Context())
    except Exception:
        _LOGGER.exception("Error while testing %s", script.name)


@callback
def _test_variables(
    entry: ConfigEntry, subentry: ConfigSubentry, mode_key: str, action: str
) -> dict[str, Any]:
    """Build the script variables of a test run, mirroring a real press."""
    mode = async_current_mode(entry, subentry.subentry_id) or 1
    if mode_key != MODELESS_MODE_KEY:
        mode = _as_int(mode_key, mode) or mode

    level: int | None = None
    if action == ACTION_WHEEL:
        runtime = async_get_remote_runtime(entry, subentry.subentry_id)
        coordinator = getattr(runtime, "coordinator", None)
        level = _as_int(getattr(coordinator, "wheel_level", None), _TEST_WHEEL_LEVEL)

    return {
        ATTR_REMOTE_ID: subentry.subentry_id,
        ATTR_ACTION: action,
        ATTR_MODE: mode,
        ATTR_MODE_NAME: mode_label(subentry, mode),
        ATTR_MODE_SOURCE: ModeConfig.from_data(subentry.data).source,
        ATTR_ACTION_GROUP: None,
        ATTR_LEVEL: level,
        ATTR_LEVEL_PCT: _level_pct(level),
        ATTR_LEVEL_254: None if level is None else min(level, _LEVEL_MAX_FOR_LIGHTS),
        ATTR_PREVIOUS_LEVEL: None,
        ATTR_DELTA: None,
        ATTR_DIRECTION: None,
    }


def _level_pct(level: int | None) -> int | None:
    """Return an absolute wheel level as a rounded percentage."""
    if level is None:
        return None
    return round(level * 100 / WHEEL_LEVEL_MAX)


# --------------------------------------------------------------------------- #
# bilresa_remote/subscribe_events
# --------------------------------------------------------------------------- #


@callback
def _async_slot_for(subentry: ConfigSubentry, action: str, mode: int) -> tuple[str, bool]:
    """Return ``(mode_key, has_binding)`` for an action, as the dispatcher sees it.

    Double and triple click are the only actions without a channel, so the user
    decides per remote whether they are mode independent. The lookup order below
    is the same one ``dispatcher._async_lookup`` uses, otherwise the panel would
    highlight a slot that is not the one being executed.
    """
    if action in ACTIONS_WITHOUT_MODE:
        if modeless_multiclick(subentry):
            candidates = (MODELESS_MODE_KEY, str(mode))
        else:
            candidates = (str(mode), MODELESS_MODE_KEY)
    else:
        candidates = (str(mode),)

    mappings = _raw_mappings(subentry)
    for mode_key in candidates:
        bindings = mappings.get(mode_key)
        if not isinstance(bindings, Mapping):
            continue
        sequence, _script_mode, _throttle = _unpack_binding(bindings.get(action))
        if sequence:
            return mode_key, True
    return candidates[0], False


@callback
def _async_find_subentry(entry: ConfigEntry, identifier: str) -> ConfigSubentry | None:
    """Resolve a remote by subentry id or by hardware address."""
    subentry = entry.subentries.get(identifier)
    if subentry is not None and subentry.subentry_type == SUBENTRY_TYPE_REMOTE:
        return subentry
    for candidate in remote_subentries(entry):
        if remote_ieee(candidate) == identifier:
            return candidate
    return None


@callback
def _async_event_payload(entry: ConfigEntry, event: Any) -> dict[str, Any] | None:
    """Turn a dispatched action into the event shape of the contract."""
    identifier = event_remote_id(event)
    if identifier is None:
        return None
    subentry = _async_find_subentry(entry, identifier)
    if subentry is None:
        return None

    raw_action = event_value(event, ATTR_ACTION)
    if not raw_action:
        return None
    action = resolve_action(str(raw_action), subentry)

    mode = _as_int(event_value(event, ATTR_MODE), 1) or 1
    mode_key, has_binding = _async_slot_for(subentry, action, mode)

    level: int | None = None
    level_pct: int | None = None
    direction: Any = None
    if action == ACTION_WHEEL:
        level = _as_int(event_value(event, ATTR_LEVEL))
        level_pct = _as_int(event_value(event, ATTR_LEVEL_PCT))
        if level_pct is None:
            level_pct = _level_pct(level)
        direction = event_value(event, ATTR_DIRECTION)

    timestamp = event_value(event, "timestamp")
    if hasattr(timestamp, "isoformat"):
        stamp = timestamp.isoformat()
    elif timestamp:
        stamp = str(timestamp)
    else:
        stamp = dt_util.utcnow().isoformat()

    return {
        "subentry_id": subentry.subentry_id,
        CONF_IEEE: remote_ieee(subentry),
        ATTR_ACTION: action,
        ATTR_MODE: mode,
        "mode_key": mode_key,
        ATTR_LEVEL: level,
        ATTR_LEVEL_PCT: level_pct,
        ATTR_DIRECTION: direction,
        "has_binding": has_binding,
        "timestamp": stamp,
    }


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): WS_SUBSCRIBE_EVENTS})
@callback
def websocket_subscribe_events(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Stream every normalised remote action to the panel.

    This is what makes assigning actions obvious: the slot that was just pressed
    lights up instead of the user having to guess which mode they are in.
    """
    msg_id = msg["id"]

    @callback
    def _forward(event: Any) -> None:
        """Forward one action. Runs inside a dispatcher callback: never raises."""
        try:
            entry = _async_entry(hass)
            if entry is None:
                return
            payload = _async_event_payload(entry, event)
            if payload is None:
                return
            connection.send_message(websocket_api.event_message(msg_id, payload))
        except Exception:
            _LOGGER.exception("Could not forward a remote action to the panel")

    connection.subscriptions[msg_id] = async_dispatcher_connect(hass, SIGNAL_ACTION, _forward)
    connection.send_result(msg_id)


# --------------------------------------------------------------------------- #
# Command table
# --------------------------------------------------------------------------- #

_COMMANDS: Final = (
    websocket_config,
    websocket_discover,
    websocket_remote_create,
    websocket_remote_update,
    websocket_remote_delete,
    websocket_binding_set,
    websocket_binding_clear,
    websocket_binding_test,
    websocket_subscribe_events,
)
