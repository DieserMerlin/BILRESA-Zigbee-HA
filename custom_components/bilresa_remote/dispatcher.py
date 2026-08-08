"""Action dispatcher for the IKEA BILRESA Remote integration.

This module is the execution side of the integration. It owns every
:class:`homeassistant.helpers.script.Script` that is built from the sequences
stored in the ``remote`` config subentries, decides which script a normalised
action maps to, and runs it.

Contract towards the input side (``coordinator.py`` / ``mode.py``)
------------------------------------------------------------------
An *action event* is delivered either by calling
:meth:`BilresaDispatcher.async_handle_action` directly, or via
``async_dispatcher_send`` on :data:`~.const.SIGNAL_ACTION` (global) or on
``f"{SIGNAL_ACTION}_{subentry_id}"`` (per remote). The payload may be any
object or mapping exposing the ``ATTR_*`` names from :mod:`.const`:

``remote_id`` (the subentry id), ``action`` (normalised taxonomy value),
``mode`` (1-based int), ``mode_name``, ``mode_source``, ``action_group`` and,
for wheel events, ``level``, ``level_pct``, ``level_254``, ``previous_level``,
``delta`` and ``direction``.

Everything that is missing is derived where possible. Delivering the same
payload object on both the global and the per-remote signal is safe; it is
de-duplicated by identity.

This module additionally hosts the small helper layer shared by the four entity
platforms (device info, mode names, base entity). They live here because the
dispatcher is the runtime module every platform already depends on.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from functools import partial
from inspect import isawaitable
from time import monotonic
from typing import Any, Final

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.core import CALLBACK_TYPE, Context, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import (
    async_dispatcher_connect,
    async_dispatcher_send,
)
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.script import (
    DEFAULT_MAX,
    SCRIPT_MODE_CHOICES,
    SCRIPT_MODE_RESTART,
    SCRIPT_MODE_SINGLE,
    Script,
    async_validate_actions_config,
)
from homeassistant.helpers.typing import ConfigType

from .const import (
    ACTION_CLICK,
    ACTION_CLICK_OFF,
    ACTION_CLICK_ON,
    ACTION_WHEEL,
    ACTIONS_WITHOUT_MODE,
    ATTR_ACTION,
    ATTR_ACTION_GROUP,
    ATTR_DELTA,
    ATTR_DIRECTION,
    ATTR_IS_MODE_CYCLE,
    ATTR_LEVEL,
    ATTR_LEVEL_254,
    ATTR_LEVEL_PCT,
    ATTR_MODE,
    ATTR_MODE_NAME,
    ATTR_MODE_SOURCE,
    ATTR_PREVIOUS_LEVEL,
    ATTR_REMOTE_ID,
    BINDABLE_ACTIONS,
    CONF_IEEE,
    CONF_MAPPINGS,
    CONF_MODE_COUNT,
    CONF_MODE_NAMES,
    CONF_MODE_SOURCE,
    CONF_MODELESS_MULTICLICK,
    CONF_NAME,
    CONF_SCRIPT_MODE,
    CONF_SEQUENCE,
    CONF_SPLIT_SINGLE_CLICK,
    CONF_WHEEL_THROTTLE_MS,
    DEFAULT_MODE_COUNT,
    DEFAULT_MODE_SOURCE,
    DEFAULT_MODELESS_MULTICLICK,
    DEFAULT_SPLIT_SINGLE_CLICK,
    DEFAULT_WHEEL_THROTTLE_MS,
    DOMAIN,
    ISSUE_INVALID_SEQUENCE,
    MANUFACTURER,
    MODEL_WHEEL,
    MODEL_WHEEL_NAME,
    SIGNAL_ACTION,
    SIGNAL_MODE_CHANGED,
    SUBENTRY_TYPE_REMOTE,
    WHEEL_LEVEL_MAX,
    WHEEL_LEVEL_MIN,
)

_LOGGER = logging.getLogger(__name__)

#: Mapping key used for double/triple click when they are configured
#: mode-independently. ``*`` cannot collide with a mode index.
MODELESS_MODE_KEY: Final = "*"

#: Legacy/alternative container name for the per-mode mappings.
_LEGACY_MAPPINGS_KEY: Final = "modes"

#: Maximum brightness a Zigbee light accepts; the wheel itself goes to 255.
_LEVEL_LIGHT_MAX: Final = 254

#: An action payload delivered on both the global and the per-remote signal
#: arrives in the same event loop iteration. Anything slower than this is a new
#: press, even if the producer happens to reuse the payload object.
_DEDUP_WINDOW: Final = 0.05

#: ``(subentry_id, mode_key, action)``
SlotKey = tuple[str, str, str]


# --------------------------------------------------------------------------- #
# Payload access
# --------------------------------------------------------------------------- #


def event_value(event: Any, key: str, default: Any = None) -> Any:
    """Read ``key`` from an action event, mapping or object alike."""
    if event is None:
        return default
    value = event.get(key) if isinstance(event, Mapping) else getattr(event, key, None)
    return default if value is None else value


def event_remote_id(event: Any) -> str | None:
    """Return the remote (subentry) id an action event belongs to."""
    for key in (ATTR_REMOTE_ID, "subentry_id", "ieee"):
        value = event_value(event, key)
        if value:
            return str(value)
    return None


def _as_int(value: Any) -> int | None:
    """Best effort int conversion that never raises."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Subentry helpers shared by the entity platforms
# --------------------------------------------------------------------------- #


def remote_subentries(entry: ConfigEntry) -> list[ConfigSubentry]:
    """Return all ``remote`` subentries of the config entry."""
    return [
        subentry
        for subentry in entry.subentries.values()
        if subentry.subentry_type == SUBENTRY_TYPE_REMOTE
    ]


def remote_ieee(subentry: ConfigSubentry) -> str:
    """Return the stable hardware identifier of a remote."""
    value = subentry.data.get(CONF_IEEE) or subentry.unique_id
    return str(value or subentry.subentry_id)


def remote_name(subentry: ConfigSubentry) -> str:
    """Return the user facing name of a remote."""
    value = subentry.data.get(CONF_NAME) or subentry.title
    return str(value or remote_ieee(subentry))


def mode_count(subentry: ConfigSubentry) -> int:
    """Return how many modes this remote is configured for."""
    count = _as_int(subentry.data.get(CONF_MODE_COUNT)) or DEFAULT_MODE_COUNT
    return max(1, min(count, 10))


def mode_names(subentry: ConfigSubentry) -> list[str]:
    """Return the mode labels, falling back to ``Mode 1..n``.

    Labels double as ``select`` options, so they are forced to be unique.
    """
    count = mode_count(subentry)
    raw: Any = subentry.data.get(CONF_MODE_NAMES) or []
    if isinstance(raw, Mapping):
        raw = [raw.get(str(index + 1)) for index in range(count)]
    if not isinstance(raw, (list, tuple)):
        raw = []

    names: list[str] = []
    used: set[str] = set()
    for index in range(count):
        candidate = raw[index] if index < len(raw) else None
        label = str(candidate).strip() if candidate not in (None, "") else ""
        if not label:
            label = f"Mode {index + 1}"
        unique = label
        suffix = 2
        while unique in used:
            unique = f"{label} ({suffix})"
            suffix += 1
        used.add(unique)
        names.append(unique)
    return names


def mode_label(subentry: ConfigSubentry, mode: int | None) -> str:
    """Return the label of a 1-based mode index."""
    names = mode_names(subentry)
    index = (mode or 1) - 1
    if 0 <= index < len(names):
        return names[index]
    return f"Mode {mode}"


def split_single_click(subentry: ConfigSubentry) -> bool:
    """Return whether the alternating single click is bound separately."""
    return bool(subentry.data.get(CONF_SPLIT_SINGLE_CLICK, DEFAULT_SPLIT_SINGLE_CLICK))


def modeless_multiclick(subentry: ConfigSubentry) -> bool:
    """Return whether double/triple click ignore the current mode."""
    return bool(subentry.data.get(CONF_MODELESS_MULTICLICK, DEFAULT_MODELESS_MULTICLICK))


def resolve_action(action: str, subentry: ConfigSubentry) -> str:
    """Collapse the on/off parity of the single click unless the user split it.

    The single click alternates ``on``/``off`` in the device firmware; that is a
    device-internal counter, not a state. Unless ``split_single_click`` is set,
    both parities are the same user-visible action.
    """
    if action in (ACTION_CLICK_ON, ACTION_CLICK_OFF) and not split_single_click(subentry):
        return ACTION_CLICK
    return action


def build_device_info(subentry: ConfigSubentry) -> DeviceInfo:
    """Return the shared device info for one remote."""
    ieee = remote_ieee(subentry)
    return DeviceInfo(
        identifiers={(DOMAIN, ieee)},
        manufacturer=MANUFACTURER,
        model=MODEL_WHEEL_NAME,
        model_id=MODEL_WHEEL,
        name=remote_name(subentry),
        serial_number=ieee,
    )


def mode_source(subentry: ConfigSubentry) -> str:
    """Return the configured mode source of a remote."""
    return str(subentry.data.get(CONF_MODE_SOURCE) or DEFAULT_MODE_SOURCE)


# --------------------------------------------------------------------------- #
# Runtime access (mode resolver lives in mode.py, which this module does not own)
# --------------------------------------------------------------------------- #

_MODE_SETTERS: Final = ("async_set_mode", "async_select_mode", "set_mode")
#: ``mode.ModeResolver`` spells its cycler ``async_cycle``; it has to come first
#: so the "next mode" button goes through the resolver and therefore honours the
#: per-remote ``cycle_wrap`` option instead of the always-wrapping fallback.
_MODE_CYCLERS: Final = (
    "async_cycle",
    "async_next_mode",
    "async_cycle_mode",
    "next_mode",
)
#: Attributes on a mode owner that hold the current 1-based mode.
_MODE_READERS: Final = ("current", "current_mode", "mode")
_RUNTIME_CONTAINERS: Final = ("remotes", "modes", "mode_resolvers", "coordinators")
_MODE_OWNER_ATTRS: Final = ("mode_resolver", "resolver", "mode", "modes")


def _runtime_container(runtime: Any, name: str) -> Mapping[str, Any] | None:
    """Return a per-remote mapping stored on the runtime data object."""
    value = runtime.get(name) if isinstance(runtime, Mapping) else getattr(runtime, name, None)
    return value if isinstance(value, Mapping) else None


def async_get_remote_runtime(entry: ConfigEntry, subentry_id: str) -> Any | None:
    """Return the per-remote runtime object, if the integration exposes one."""
    runtime = getattr(entry, "runtime_data", None)
    if runtime is None:
        return None
    for name in _RUNTIME_CONTAINERS:
        container = _runtime_container(runtime, name)
        if container is not None and subentry_id in container:
            return container[subentry_id]
    return None


def _mode_owner(entry: ConfigEntry, subentry_id: str, methods: Iterable[str]) -> Any:
    """Return the object that implements one of ``methods`` for a remote."""
    root = async_get_remote_runtime(entry, subentry_id)
    if root is None:
        return None
    candidates = [root]
    for attr in _MODE_OWNER_ATTRS:
        nested = getattr(root, attr, None)
        if nested is not None and not isinstance(nested, (str, int, Mapping)):
            candidates.append(nested)
    for candidate in candidates:
        if any(callable(getattr(candidate, name, None)) for name in methods):
            return candidate
    return None


async def _async_call_mode_owner(owner: Any, methods: Iterable[str], *args: Any) -> bool:
    """Call the first available method on the mode owner."""
    for name in methods:
        method = getattr(owner, name, None)
        if not callable(method):
            continue
        result = method(*args)
        if isawaitable(result):
            await result
        return True
    return False


async def async_request_mode(
    hass: HomeAssistant, entry: ConfigEntry, subentry_id: str, mode: int
) -> None:
    """Ask the mode resolver to switch a remote to ``mode``.

    ``mode.py`` owns the authoritative mode state. If it does not expose a
    setter under any of the expected names we still keep the integration
    consistent by announcing the change ourselves.
    """
    owner = _mode_owner(entry, subentry_id, _MODE_SETTERS)
    if owner is not None and await _async_call_mode_owner(owner, _MODE_SETTERS, mode):
        return
    _LOGGER.debug(
        "No mode setter available for %s, announcing mode %s directly",
        subentry_id,
        mode,
    )
    payload = {ATTR_REMOTE_ID: subentry_id, ATTR_MODE: mode}
    async_dispatcher_send(hass, f"{SIGNAL_MODE_CHANGED}_{subentry_id}", payload)
    async_dispatcher_send(hass, SIGNAL_MODE_CHANGED, payload)


async def async_request_next_mode(
    hass: HomeAssistant, entry: ConfigEntry, subentry_id: str, current: int
) -> None:
    """Advance a remote to the next mode, wrapping around."""
    owner = _mode_owner(entry, subentry_id, _MODE_CYCLERS)
    if owner is not None and await _async_call_mode_owner(owner, _MODE_CYCLERS):
        return
    subentry = entry.subentries.get(subentry_id)
    count = mode_count(subentry) if subentry is not None else DEFAULT_MODE_COUNT
    await async_request_mode(hass, entry, subentry_id, (current % count) + 1)


@callback
def async_current_mode(entry: ConfigEntry, subentry_id: str) -> int | None:
    """Return the mode the resolver currently holds, or None if unavailable.

    Entities use this when they have nothing to restore: without it a fresh
    entity would claim mode 1 while the resolver already restored a different
    mode from its own store.
    """
    owner = _mode_owner(entry, subentry_id, _MODE_SETTERS)
    if owner is None:
        return None
    for name in _MODE_READERS:
        value = getattr(owner, name, None)
        if value is None or callable(value):
            continue
        mode = _as_int(value)
        if mode is not None and mode >= 1:
            return mode
    return None


def mode_from_payload(payload: Any, default: int | None = None) -> int | None:
    """Extract a 1-based mode index from a ``SIGNAL_MODE_CHANGED`` payload."""
    direct = _as_int(payload)
    if direct is not None:
        return direct
    if isinstance(payload, (list, tuple)):
        for item in payload:
            value = _as_int(item)
            if value is not None:
                return value
        return default
    value = _as_int(event_value(payload, ATTR_MODE))
    return value if value is not None else default


# --------------------------------------------------------------------------- #
# Script slots
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class _Slot:
    """One executable binding."""

    script: Script
    throttle: float = 0.0


@dataclass(slots=True)
class _Throttle:
    """Leading + trailing edge throttle state of a wheel slot."""

    last_run: float = 0.0
    pending: dict[str, Any] | None = None
    unsub: CALLBACK_TYPE | None = None


@dataclass(slots=True)
class _RemoteScripts:
    """Everything the dispatcher holds for a single remote."""

    fingerprint: str = ""
    slots: dict[SlotKey, _Slot] = field(default_factory=dict)
    throttles: dict[SlotKey, _Throttle] = field(default_factory=dict)
    issues: set[str] = field(default_factory=set)


def _unpack_binding(raw: Any) -> tuple[list[Any], str | None, int | None]:
    """Return ``(sequence, script_mode, throttle_ms)`` from a stored binding."""
    if raw is None:
        return [], None, None
    if isinstance(raw, Mapping):
        sequence = raw.get(CONF_SEQUENCE)
        script_mode = raw.get(CONF_SCRIPT_MODE)
        throttle = _as_int(raw.get(CONF_WHEEL_THROTTLE_MS))
        if sequence is None:
            if not set(raw) - {CONF_SEQUENCE, CONF_SCRIPT_MODE, CONF_WHEEL_THROTTLE_MS}:
                # Options only, no sequence: an unbound slot, not a broken one.
                return [], script_mode, throttle
            # A bare action mapping (``{"action": "light.turn_on", ...}``).
            return [dict(raw)], script_mode, throttle
    else:
        sequence, script_mode, throttle = raw, None, None
    if sequence is None:
        return [], script_mode, throttle
    if isinstance(sequence, Mapping):
        sequence = [dict(sequence)]
    if not isinstance(sequence, (list, tuple)):
        return [], script_mode, throttle
    return list(sequence), script_mode, throttle


def _throttle_seconds(value: Any, fallback: int) -> float:
    """Return a throttle window in seconds, clamped to something sane."""
    millis = _as_int(value)
    if millis is None:
        millis = fallback
    return max(0.0, min(millis, 10_000)) / 1000


class BilresaDispatcher:
    """Builds, owns and runs the scripts configured for every remote."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialise the dispatcher for one config entry."""
        self.hass = hass
        self.entry = entry
        self._remotes: dict[str, _RemoteScripts] = {}
        self._unsubs: list[CALLBACK_TYPE] = []
        self._remote_unsubs: dict[str, CALLBACK_TYPE] = {}
        # Keeping a reference is what makes the identity check safe: the object
        # cannot be collected and its id cannot be reused while we hold it.
        self._last_event: Any = None
        self._last_event_at = 0.0

    # -- lifecycle -------------------------------------------------------- #

    async def async_setup(self) -> None:
        """Build all scripts and subscribe to the action signal."""
        self._unsubs.append(async_dispatcher_connect(self.hass, SIGNAL_ACTION, self._async_signal))
        for subentry in remote_subentries(self.entry):
            await self.async_rebuild_remote(subentry.subentry_id)

    async def async_shutdown(self) -> None:
        """Stop every running script and drop all subscriptions."""
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        for unsub in self._remote_unsubs.values():
            unsub()
        self._remote_unsubs.clear()
        for subentry_id in list(self._remotes):
            await self._async_teardown_remote(subentry_id, delete_issues=False)

    async def async_handle_entry_update(self) -> None:
        """Rebuild only what actually changed.

        Reloading the whole config entry on every mapping edit would tear down
        the MQTT subscriptions and every entity, so we diff instead.
        """
        current = {subentry.subentry_id: subentry for subentry in remote_subentries(self.entry)}
        for subentry_id in list(self._remotes):
            if subentry_id not in current:
                await self._async_teardown_remote(subentry_id)
        for subentry_id, subentry in current.items():
            known = self._remotes.get(subentry_id)
            if known is not None and known.fingerprint == _fingerprint(subentry):
                continue
            await self.async_rebuild_remote(subentry_id)

    async def async_rebuild_remote(self, subentry_id: str) -> None:
        """(Re)build the scripts of a single remote."""
        subentry = self.entry.subentries.get(subentry_id)
        if subentry is None or subentry.subentry_type != SUBENTRY_TYPE_REMOTE:
            await self._async_teardown_remote(subentry_id)
            return

        await self._async_teardown_remote(subentry_id, keep_subscription=True)
        state = _RemoteScripts(fingerprint=_fingerprint(subentry))
        self._remotes[subentry_id] = state

        if subentry_id not in self._remote_unsubs:
            self._remote_unsubs[subentry_id] = async_dispatcher_connect(
                self.hass,
                f"{SIGNAL_ACTION}_{subentry_id}",
                partial(self._async_signal, subentry_id=subentry_id),
            )

        default_throttle = _throttle_seconds(
            subentry.data.get(CONF_WHEEL_THROTTLE_MS), DEFAULT_WHEEL_THROTTLE_MS
        )
        mappings = subentry.data.get(CONF_MAPPINGS)
        if not isinstance(mappings, Mapping):
            mappings = subentry.data.get(_LEGACY_MAPPINGS_KEY)
        if not isinstance(mappings, Mapping):
            _LOGGER.debug("Remote %s has no action mappings", remote_name(subentry))
            return

        for raw_mode_key, bindings in mappings.items():
            mode_key = str(raw_mode_key)
            if not isinstance(bindings, Mapping):
                _LOGGER.warning(
                    "Ignoring malformed mappings for %s mode %s",
                    remote_name(subentry),
                    mode_key,
                )
                continue
            for action, raw in bindings.items():
                if action not in BINDABLE_ACTIONS:
                    _LOGGER.debug("Ignoring unknown action %s", action)
                    continue
                await self._async_build_slot(
                    subentry, state, mode_key, str(action), raw, default_throttle
                )

        _LOGGER.debug("Built %s script(s) for remote %s", len(state.slots), remote_name(subentry))

    async def _async_build_slot(
        self,
        subentry: ConfigSubentry,
        state: _RemoteScripts,
        mode_key: str,
        action: str,
        raw: Any,
        default_throttle: float,
    ) -> None:
        """Validate one stored sequence and turn it into a Script."""
        sequence, script_mode, throttle_ms = _unpack_binding(raw)
        if not sequence:
            return

        validated = await self._async_validate(subentry, state, mode_key, action, sequence)
        if validated is None:
            return

        if script_mode not in SCRIPT_MODE_CHOICES:
            # Absolute wheel values: a newer value fully replaces the older one.
            script_mode = SCRIPT_MODE_RESTART if action == ACTION_WHEEL else SCRIPT_MODE_SINGLE

        label = "all modes" if mode_key == MODELESS_MODE_KEY else f"mode {mode_key}"
        name = f"{remote_name(subentry)} {label} {action}"
        script = Script(
            self.hass,
            validated,
            name,
            DOMAIN,
            logger=_LOGGER,
            max_runs=DEFAULT_MAX,
            running_description=f"{name} action",
            script_mode=script_mode,
        )

        throttle = (
            _throttle_seconds(throttle_ms, int(default_throttle * 1000))
            if action == ACTION_WHEEL
            else 0.0
        )
        state.slots[(subentry.subentry_id, mode_key, action)] = _Slot(script, throttle)

    async def _async_validate(
        self,
        subentry: ConfigSubentry,
        state: _RemoteScripts,
        mode_key: str,
        action: str,
        sequence: list[Any],
    ) -> list[ConfigType] | None:
        """Validate a stored sequence; never let a broken one break setup.

        The UI action selector is a pure pass-through and validates nothing, so
        anything can end up in the subentry. A single bad sequence must cost the
        user exactly that one binding, not the whole integration.
        """
        issue_id = f"{ISSUE_INVALID_SEQUENCE}_{subentry.subentry_id}_{mode_key}_{action}"
        try:
            config = cv.SCRIPT_SCHEMA(sequence)
            validated = await async_validate_actions_config(self.hass, config)
        except (vol.Invalid, HomeAssistantError) as err:
            self._async_report_invalid(subentry, state, issue_id, mode_key, action, err)
            return None
        except Exception:
            _LOGGER.exception(
                "Unexpected error validating action %s of remote %s (mode %s)",
                action,
                remote_name(subentry),
                mode_key,
            )
            self._async_report_invalid(
                subentry, state, issue_id, mode_key, action, "unexpected error"
            )
            return None

        ir.async_delete_issue(self.hass, DOMAIN, issue_id)
        return validated

    @callback
    def _async_report_invalid(
        self,
        subentry: ConfigSubentry,
        state: _RemoteScripts,
        issue_id: str,
        mode_key: str,
        action: str,
        error: Any,
    ) -> None:
        """Log a broken sequence and surface it as a repair issue."""
        _LOGGER.error(
            "Skipping invalid action sequence for remote %s (mode %s, action %s): %s",
            remote_name(subentry),
            mode_key,
            action,
            error,
        )
        state.issues.add(issue_id)
        ir.async_create_issue(
            self.hass,
            DOMAIN,
            issue_id,
            is_fixable=False,
            issue_domain=DOMAIN,
            severity=ir.IssueSeverity.WARNING,
            translation_key=ISSUE_INVALID_SEQUENCE,
            translation_placeholders={
                "remote": remote_name(subentry),
                "mode": "*" if mode_key == MODELESS_MODE_KEY else mode_key,
                "action": action,
                "error": str(error),
            },
        )

    async def _async_teardown_remote(
        self,
        subentry_id: str,
        *,
        keep_subscription: bool = False,
        delete_issues: bool = True,
    ) -> None:
        """Drop all scripts and timers of a remote."""
        state = self._remotes.pop(subentry_id, None)
        if not keep_subscription and (unsub := self._remote_unsubs.pop(subentry_id, None)):
            unsub()
        if state is None:
            return
        for throttle in state.throttles.values():
            if throttle.unsub is not None:
                throttle.unsub()
                throttle.unsub = None
            throttle.pending = None
        for slot in state.slots.values():
            try:
                await slot.script.async_stop()
            except Exception:
                _LOGGER.debug("Error stopping %s", slot.script.name, exc_info=True)
        if delete_issues:
            for issue_id in state.issues:
                ir.async_delete_issue(self.hass, DOMAIN, issue_id)

    # -- execution -------------------------------------------------------- #

    @callback
    def _async_signal(self, event: Any, subentry_id: str | None = None) -> None:
        """Handle an action delivered over the dispatcher signal."""
        self.async_handle_action(event, subentry_id)

    @callback
    def async_handle_action(self, event: Any, subentry_id: str | None = None) -> None:
        """Look up and run the script bound to a normalised action."""
        now = monotonic()
        if event is self._last_event and now - self._last_event_at < _DEDUP_WINDOW:
            # Same payload seen on both the global and the per-remote signal.
            return
        self._last_event = event
        self._last_event_at = now

        remote_id = subentry_id or event_remote_id(event)
        if remote_id is None:
            _LOGGER.debug("Action event without remote id, ignoring: %s", event)
            return
        subentry = self.entry.subentries.get(remote_id)
        if subentry is None or subentry.subentry_type != SUBENTRY_TYPE_REMOTE:
            subentry = self._subentry_by_ieee(remote_id)
        if subentry is None:
            _LOGGER.debug("Action event for unknown remote %s", remote_id)
            return

        raw_action = event_value(event, ATTR_ACTION)
        if not raw_action:
            return
        action = resolve_action(str(raw_action), subentry)

        if event_value(event, ATTR_IS_MODE_CYCLE):
            # ``mode.py`` consumed this press to advance the mode. Running the
            # binding for it as well would fire the configured cycle action --
            # a triple click by default -- on every single mode change, which is
            # never what the user meant when they picked it as the cycle action.
            _LOGGER.debug(
                "Press %s of %s was consumed as the mode cycle, not running a binding for it",
                action,
                remote_name(subentry),
            )
            return

        state = self._remotes.get(subentry.subentry_id)
        if state is None:
            return

        mode = _as_int(event_value(event, ATTR_MODE)) or 1
        slot_key = self._async_lookup(state, subentry, action, mode)
        if slot_key is None:
            _LOGGER.debug(
                "No binding for %s / mode %s / %s",
                remote_name(subentry),
                mode,
                action,
            )
            return

        slot = state.slots[slot_key]
        variables = _run_variables(event, subentry, action, mode)
        if action == ACTION_WHEEL and slot.throttle > 0:
            self._async_run_throttled(state, slot_key, slot, variables)
        else:
            self._async_run(slot, variables)

    def _subentry_by_ieee(self, ieee: str) -> ConfigSubentry | None:
        """Resolve a remote by its hardware id."""
        for subentry in remote_subentries(self.entry):
            if remote_ieee(subentry) == ieee:
                return subentry
        return None

    @callback
    def _async_lookup(
        self,
        state: _RemoteScripts,
        subentry: ConfigSubentry,
        action: str,
        mode: int,
    ) -> SlotKey | None:
        """Return the slot key for an action.

        This is where the central user decision lives. Double and triple click
        are the only actions the hardware sends without ``action_group``, so
        there is no way to tell which channel they belong to. The user picks the
        behaviour per remote:

        * ``modeless_multiclick = True``  -> one binding per remote, stored
          under :data:`MODELESS_MODE_KEY`; the current mode is ignored.
        * ``modeless_multiclick = False`` -> one binding per mode, using the
          last known mode as reported by the mode resolver.

        The opposite key is kept as a fallback so that flipping the option does
        not silently orphan bindings the user already configured.
        """
        if action in ACTIONS_WITHOUT_MODE:
            if modeless_multiclick(subentry):
                candidates = (MODELESS_MODE_KEY, str(mode))
            else:
                candidates = (str(mode), MODELESS_MODE_KEY)
        else:
            candidates = (str(mode),)

        for mode_key in candidates:
            key = (subentry.subentry_id, mode_key, action)
            if key in state.slots:
                return key
        return None

    @callback
    def _async_run_throttled(
        self,
        state: _RemoteScripts,
        key: SlotKey,
        slot: _Slot,
        variables: dict[str, Any],
    ) -> None:
        """Throttle wheel execution but always deliver the final detent.

        A fast spin produces a burst of absolute levels. Running each one floods
        the target; running only the leading one leaves the light on an
        intermediate value. So: run immediately when the window is free, and
        schedule the newest pending value for the end of the window.
        """
        throttle = state.throttles.setdefault(key, _Throttle())
        now = monotonic()
        remaining = throttle.last_run + slot.throttle - now

        if remaining <= 0 and throttle.unsub is None:
            throttle.last_run = now
            self._async_run(slot, variables)
            return

        throttle.pending = variables
        if throttle.unsub is None:
            throttle.unsub = async_call_later(
                self.hass,
                max(remaining, 0.0),
                partial(self._async_trailing, key),
            )

    @callback
    def _async_trailing(self, key: SlotKey, _now: datetime) -> None:
        """Deliver the last value seen during a throttle window."""
        state = self._remotes.get(key[0])
        if state is None:
            return
        throttle = state.throttles.get(key)
        if throttle is None:
            return
        throttle.unsub = None
        variables = throttle.pending
        throttle.pending = None
        slot = state.slots.get(key)
        if slot is None or variables is None:
            return
        throttle.last_run = monotonic()
        self._async_run(slot, variables)

    @callback
    def _async_run(self, slot: _Slot, variables: dict[str, Any]) -> None:
        """Start a script run with its own context."""
        # A fresh context per run makes every state change the script causes
        # traceable back to this remote press in the logbook.
        context = Context()
        _LOGGER.debug("Running %s (context %s) with %s", slot.script.name, context.id, variables)
        self.entry.async_create_background_task(
            self.hass,
            self._async_execute(slot, variables, context),
            f"{DOMAIN}_run_{slot.script.name}",
            eager_start=True,
        )

    async def _async_execute(
        self, slot: _Slot, variables: dict[str, Any], context: Context
    ) -> None:
        """Run a script, swallowing failures so one binding cannot kill others."""
        try:
            await slot.script.async_run(run_variables=variables, context=context)
        except Exception:
            _LOGGER.exception("Error while running %s", slot.script.name)


def _fingerprint(subentry: ConfigSubentry) -> str:
    """Return a stable hash of everything the scripts are built from."""
    payload = {
        key: subentry.data.get(key)
        for key in (
            CONF_MAPPINGS,
            _LEGACY_MAPPINGS_KEY,
            CONF_SPLIT_SINGLE_CLICK,
            CONF_MODELESS_MULTICLICK,
            CONF_WHEEL_THROTTLE_MS,
            CONF_NAME,
        )
    }
    return json.dumps(payload, sort_keys=True, default=repr)


def _run_variables(event: Any, subentry: ConfigSubentry, action: str, mode: int) -> dict[str, Any]:
    """Build the variables handed to a script run."""
    level = _as_int(event_value(event, ATTR_LEVEL))
    previous = _as_int(event_value(event, ATTR_PREVIOUS_LEVEL))
    delta = _as_int(event_value(event, ATTR_DELTA))
    if delta is None and level is not None and previous is not None:
        delta = level - previous

    level_pct = _as_int(event_value(event, ATTR_LEVEL_PCT))
    level_254 = _as_int(event_value(event, ATTR_LEVEL_254))
    if level is not None:
        level = max(WHEEL_LEVEL_MIN, min(level, WHEEL_LEVEL_MAX))
        if level_pct is None:
            level_pct = round(level / WHEEL_LEVEL_MAX * 100)
        if level_254 is None:
            level_254 = min(level, _LEVEL_LIGHT_MAX)

    direction = event_value(event, ATTR_DIRECTION)
    if direction is None and delta:
        direction = "up" if delta > 0 else "down"

    return {
        ATTR_REMOTE_ID: subentry.subentry_id,
        ATTR_ACTION: action,
        ATTR_MODE: mode,
        ATTR_MODE_NAME: event_value(event, ATTR_MODE_NAME) or mode_label(subentry, mode),
        ATTR_MODE_SOURCE: event_value(event, ATTR_MODE_SOURCE) or mode_source(subentry),
        ATTR_ACTION_GROUP: _as_int(event_value(event, ATTR_ACTION_GROUP)),
        ATTR_LEVEL: level,
        ATTR_LEVEL_PCT: level_pct,
        ATTR_LEVEL_254: level_254,
        ATTR_PREVIOUS_LEVEL: previous,
        ATTR_DELTA: delta,
        ATTR_DIRECTION: direction,
    }


# --------------------------------------------------------------------------- #
# Entity base class shared by event/select/sensor/button
# --------------------------------------------------------------------------- #


class BilresaRemoteEntity(Entity):
    """Base entity bound to one remote subentry."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry, subentry: ConfigSubentry, key: str) -> None:
        """Initialise the entity for a remote."""
        self._entry = entry
        self._subentry_id = subentry.subentry_id
        self._subentry_fallback = subentry
        self._ieee = remote_ieee(subentry)
        self._attr_unique_id = f"{self._ieee}_{key}"
        self._attr_device_info = build_device_info(subentry)
        self._last_action_event: Any = None
        self._last_action_at = 0.0

    @property
    def subentry(self) -> ConfigSubentry:
        """Return the live subentry, falling back to the one seen at setup."""
        return self._entry.subentries.get(self._subentry_id, self._subentry_fallback)

    async def async_added_to_hass(self) -> None:
        """Subscribe to the action and mode signals of this remote."""
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_ACTION, self._async_action_signal)
        )
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                f"{SIGNAL_ACTION}_{self._subentry_id}",
                partial(self._async_action_signal, trusted=True),
            )
        )
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_MODE_CHANGED, self._async_mode_signal)
        )
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                f"{SIGNAL_MODE_CHANGED}_{self._subentry_id}",
                partial(self._async_mode_signal, trusted=True),
            )
        )

    @callback
    def _async_action_signal(self, event: Any, trusted: bool = False) -> None:
        """Filter and de-duplicate incoming action events."""
        if not trusted:
            remote_id = event_remote_id(event)
            if remote_id is not None and remote_id not in (
                self._subentry_id,
                self._ieee,
            ):
                return
        now = monotonic()
        if event is self._last_action_event and now - self._last_action_at < _DEDUP_WINDOW:
            return
        self._last_action_event = event
        self._last_action_at = now
        self.handle_action(event)

    @callback
    def _async_mode_signal(self, payload: Any, trusted: bool = False) -> None:
        """Filter incoming mode changes."""
        if not trusted:
            remote_id = event_remote_id(payload)
            if remote_id is not None and remote_id not in (
                self._subentry_id,
                self._ieee,
            ):
                return
        mode = mode_from_payload(payload)
        if mode is not None:
            self.handle_mode(mode)

    @callback
    def handle_action(self, event: Any) -> None:
        """Handle a normalised action. Overridden where relevant."""

    @callback
    def handle_mode(self, mode: int) -> None:
        """Handle a mode change. Overridden where relevant."""
