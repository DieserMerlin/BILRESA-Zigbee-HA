"""MQTT ingestion for one BILRESA remote.

This is the entry side of the integration. It owns exactly one MQTT
subscription per remote on ``<base_topic>/<ieee>``, normalises the Zigbee2MQTT
payload into :class:`BilresaAction` and hands that to everyone else over
:data:`SIGNAL_ACTION`.

This is push, not poll -- there is deliberately no ``DataUpdateCoordinator``
here: nothing can be fetched from a sleepy battery remote.

Protocol notes that shaped the implementation (all measured against Z2M 2.13.0):

* retained messages are dropped, otherwise the last action of the previous run
  is replayed on every Home Assistant start,
* ``action_level: null`` is the ZCL non-value 0xFF and means 255,
* the wheel reports an *absolute* level, so the first value after a start or an
  MQTT reconnect only calibrates and must not fire,
* ``on``/``off`` alternate on a single click; both are reported raw as
  ``click_on``/``click_off`` plus a collapsed ``click`` -- which of the two the
  user has bound is decided downstream by ``split_single_click``,
* ``on_double``/``off_double`` never carry ``action_group``.
"""

from __future__ import annotations

import inspect
import json
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Final

from homeassistant.components import mqtt
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers.dispatcher import (
    async_dispatcher_connect,
    async_dispatcher_send,
)
from homeassistant.util import dt as dt_util

from .const import (
    ACTION_CLICK,
    ACTION_CLICK_OFF,
    ACTION_CLICK_ON,
    ACTION_WHEEL,
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
    COLORS,
    CONF_COLOR,
    CONF_IEEE,
    CONF_MODELESS_MULTICLICK,
    CONF_NAME,
    CONF_SPLIT_SINGLE_CLICK,
    CONF_WHEEL_THROTTLE_MS,
    DEFAULT_BASE_TOPIC,
    DEFAULT_COLOR,
    DEFAULT_MODELESS_MULTICLICK,
    DEFAULT_SPLIT_SINGLE_CLICK,
    DEFAULT_WHEEL_THROTTLE_MS,
    FIELD_ACTION,
    FIELD_ACTION_GROUP,
    FIELD_ACTION_LEVEL,
    FIELD_BATTERY,
    FIELD_LINKQUALITY,
    RAW_TO_ACTION,
    SIGNAL_ACTION,
    WHEEL_LEVEL_MAX,
    WHEEL_LEVEL_MIN,
    WHEEL_LEVEL_NULL_FALLBACK,
)
from .mode import ModeConfig, ModeResolver

if TYPE_CHECKING:
    from homeassistant.components.mqtt.models import ReceiveMessage

_LOGGER = logging.getLogger(__name__)

#: Alternative level field name. PR zigbee-herdsman-converters#11244 renames
#: ``action_level`` to ``brightness``; the parser tolerates both so a Z2M update
#: cannot silently break the wheel (design doc W6).
FIELD_BRIGHTNESS: Final = "brightness"

#: Level for lights: ZCL allows 255, but light entities cap at 254.
LEVEL_MAX_FOR_LIGHTS: Final = 254

DIRECTION_UP: Final = "up"
DIRECTION_DOWN: Final = "down"

EVENT_WHEEL_UP: Final = "wheel_up"
EVENT_WHEEL_DOWN: Final = "wheel_down"

#: Raw payload keys that are pure telemetry -- their presence alone is not an
#: action and must not fire anything.
_TELEMETRY_FIELDS: Final = (FIELD_BATTERY, FIELD_LINKQUALITY, "voltage")


def _coerce_int(value: Any, default: int | None = None) -> int | None:
    """Best-effort int conversion that never raises."""
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip(), 0)
        except ValueError:
            return default
    return default


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class RemoteConfig:
    """Sanitised runtime view of one ``remote`` subentry."""

    remote_id: str
    name: str
    base_topic: str = DEFAULT_BASE_TOPIC
    color: str = DEFAULT_COLOR
    mode: ModeConfig = field(default_factory=ModeConfig)
    split_single_click: bool = DEFAULT_SPLIT_SINGLE_CLICK
    modeless_multiclick: bool = DEFAULT_MODELESS_MULTICLICK
    wheel_throttle_ms: int = DEFAULT_WHEEL_THROTTLE_MS

    @classmethod
    def from_subentry(
        cls,
        data: Mapping[str, Any],
        *,
        base_topic: str = DEFAULT_BASE_TOPIC,
    ) -> RemoteConfig:
        """Build a config from raw subentry data.

        Raises ValueError when the mandatory device id is missing -- that is a
        broken config entry, not a runtime condition.
        """
        remote_id = str(data.get(CONF_IEEE) or "").strip()
        if not remote_id:
            raise ValueError(f"Remote subentry without {CONF_IEEE}")

        color = str(data.get(CONF_COLOR) or DEFAULT_COLOR)
        if color not in COLORS:
            color = DEFAULT_COLOR

        throttle = _coerce_int(data.get(CONF_WHEEL_THROTTLE_MS), DEFAULT_WHEEL_THROTTLE_MS)
        if throttle is None or throttle < 0:
            throttle = DEFAULT_WHEEL_THROTTLE_MS

        return cls(
            remote_id=remote_id,
            name=str(data.get(CONF_NAME) or remote_id),
            base_topic=str(base_topic or DEFAULT_BASE_TOPIC).strip("/") or DEFAULT_BASE_TOPIC,
            color=color,
            mode=ModeConfig.from_data(data),
            split_single_click=bool(
                data.get(CONF_SPLIT_SINGLE_CLICK, DEFAULT_SPLIT_SINGLE_CLICK)
            ),
            modeless_multiclick=bool(
                data.get(CONF_MODELESS_MULTICLICK, DEFAULT_MODELESS_MULTICLICK)
            ),
            wheel_throttle_ms=throttle,
        )

    @property
    def topic(self) -> str:
        """Return the MQTT topic of this remote."""
        return f"{self.base_topic}/{self.remote_id}"


# --------------------------------------------------------------------------- #
# Normalised event
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class BilresaAction:
    """One normalised remote action, ready for consumers.

    ``action`` keeps the click parity (``click_on``/``click_off``) while
    ``action_base`` carries the collapsed form (``click``). Consumers pick the
    one that matches their ``split_single_click`` setting; see
    :meth:`binding_keys`.
    """

    remote_id: str
    action: str
    action_base: str
    raw_action: str
    mode: int
    mode_name: str
    mode_source: str
    is_mode_cycle: bool
    action_group: int | None
    level: int | None
    level_pct: int | None
    level_254: int | None
    previous_level: int | None
    delta: int | None
    direction: str | None
    timestamp: datetime
    payload: Mapping[str, Any]

    @property
    def is_wheel(self) -> bool:
        """Return True for scroll wheel actions."""
        return self.action == ACTION_WHEEL

    @property
    def event_type(self) -> str:
        """Return the parity aware event type for the event entity."""
        if self.is_wheel:
            return EVENT_WHEEL_UP if self.direction == DIRECTION_UP else EVENT_WHEEL_DOWN
        return self.action

    @property
    def base_event_type(self) -> str:
        """Return the collapsed event type (``click`` instead of parity)."""
        if self.is_wheel:
            return self.event_type
        return self.action_base

    def binding_keys(self, *, split_single_click: bool) -> tuple[str, ...]:
        """Return the action keys to look up, most specific first.

        With ``split_single_click`` a user who only bound the generic ``click``
        still gets it; without it the parity binding is ignored entirely.
        """
        if self.action == self.action_base:
            return (self.action,)
        if split_single_click:
            return (self.action, self.action_base)
        return (self.action_base,)

    def as_variables(self) -> dict[str, Any]:
        """Return the script/template variables described in design doc 2.5."""
        return {
            ATTR_REMOTE_ID: self.remote_id,
            ATTR_ACTION: self.action_base,
            "action_parity": self.action,
            "raw_action": self.raw_action,
            ATTR_MODE: self.mode,
            ATTR_MODE_NAME: self.mode_name,
            ATTR_MODE_SOURCE: self.mode_source,
            ATTR_ACTION_GROUP: self.action_group,
            ATTR_LEVEL: self.level,
            ATTR_LEVEL_PCT: self.level_pct,
            ATTR_LEVEL_254: self.level_254,
            ATTR_PREVIOUS_LEVEL: self.previous_level,
            ATTR_DELTA: self.delta,
            ATTR_DIRECTION: self.direction,
        }

    def as_attributes(self) -> dict[str, Any]:
        """Return the attribute payload for the event entity."""
        attributes = self.as_variables()
        attributes.pop(ATTR_ACTION, None)
        return attributes


@callback
def async_subscribe_actions(
    hass: HomeAssistant,
    remote_id: str | None,
    target: Callable[[BilresaAction], None],
) -> CALLBACK_TYPE:
    """Subscribe to normalised actions, optionally filtered to one remote."""

    @callback
    def _handle(action: BilresaAction) -> None:
        if remote_id is None or action.remote_id == remote_id:
            target(action)

    return async_dispatcher_connect(hass, SIGNAL_ACTION, _handle)


# --------------------------------------------------------------------------- #
# Coordinator
# --------------------------------------------------------------------------- #


class BilresaCoordinator:
    """One MQTT subscription and the parsing state of a single remote."""

    def __init__(
        self,
        hass: HomeAssistant,
        config: RemoteConfig,
        *,
        mode_resolver: ModeResolver | None = None,
    ) -> None:
        """Initialise the coordinator; no I/O happens here."""
        self.hass = hass
        self.config = config
        self.mode = mode_resolver or ModeResolver(hass, config.remote_id, config.mode)

        self._unsubs: list[CALLBACK_TYPE] = []
        self._level: int | None = None
        self._level_calibrated = False
        self._last_action: BilresaAction | None = None
        self._last_payload: dict[str, Any] | None = None
        self._battery: int | None = None
        self._linkquality: int | None = None
        self._started = False

    # -- properties -------------------------------------------------------- #

    @property
    def remote_id(self) -> str:
        """Return the IEEE address of the remote."""
        return self.config.remote_id

    @property
    def topic(self) -> str:
        """Return the subscribed MQTT topic."""
        return self.config.topic

    @property
    def last_action(self) -> BilresaAction | None:
        """Return the most recent dispatched action."""
        return self._last_action

    @property
    def last_payload(self) -> dict[str, Any] | None:
        """Return the most recent raw payload (diagnostics, learn mode)."""
        return self._last_payload

    @property
    def wheel_level(self) -> int | None:
        """Return the last known absolute wheel level, if any."""
        return self._level

    @property
    def battery(self) -> int | None:
        """Return the last reported battery percentage."""
        return self._battery

    @property
    def linkquality(self) -> int | None:
        """Return the last reported link quality."""
        return self._linkquality

    # -- lifecycle --------------------------------------------------------- #

    async def async_start(self) -> None:
        """Subscribe to MQTT and restore the mode state."""
        if self._started:
            return

        if not await mqtt.async_wait_for_mqtt_client(self.hass):
            raise ConfigEntryNotReady("MQTT integration is not available")

        await self.mode.async_load()

        self._unsubs.append(
            await mqtt.async_subscribe(self.hass, self.topic, self._async_message_received)
        )
        self._async_watch_connection()
        self._started = True
        _LOGGER.debug("Remote %s listening on %s", self.remote_id, self.topic)

    async def async_stop(self) -> None:
        """Tear down the subscription and all timers."""
        self._started = False
        while self._unsubs:
            unsub = self._unsubs.pop()
            try:
                unsub()
            except Exception:  # noqa: BLE001 - unloading must never fail
                _LOGGER.exception("Error while unsubscribing remote %s", self.remote_id)
        self.mode.async_shutdown()
        _LOGGER.debug("Remote %s stopped listening on %s", self.remote_id, self.topic)

    @callback
    def async_update_config(self, config: RemoteConfig) -> None:
        """Apply changed options.

        Only non-structural changes are handled here; a changed topic requires a
        restart of the coordinator by the caller.
        """
        self.config = config
        self.mode.async_update_config(config.mode)

    def _async_watch_connection(self) -> None:
        """Invalidate the wheel calibration whenever MQTT drops.

        Missing detents while disconnected would otherwise produce a huge delta
        on the first message after the reconnect.
        """
        subscribe = getattr(mqtt, "async_subscribe_connection_status", None)
        if subscribe is None:
            return
        try:
            result = subscribe(self.hass, self._async_connection_status)
        except Exception:  # noqa: BLE001 - purely an optimisation
            _LOGGER.debug("MQTT connection status unavailable", exc_info=True)
            return
        if inspect.isawaitable(result):
            # Defensive: the helper is a callback today, but awaiting keeps us
            # working if that ever changes.
            self.hass.async_create_task(self._async_await_unsub(result))
            return
        if callable(result):
            self._unsubs.append(result)

    async def _async_await_unsub(self, awaitable: Any) -> None:
        unsub = await awaitable
        if callable(unsub):
            self._unsubs.append(unsub)

    @callback
    def _async_connection_status(self, connected: bool) -> None:
        if not connected and self._level_calibrated:
            _LOGGER.debug(
                "MQTT disconnected, dropping wheel calibration of %s", self.remote_id
            )
            self._level_calibrated = False

    # -- message handling -------------------------------------------------- #

    @callback
    def _async_message_received(self, msg: ReceiveMessage) -> None:
        """Handle one MQTT message. Never raises."""
        if msg.retain:
            # Replaying the retained payload would re-fire the last action of
            # the previous run on every Home Assistant start.
            _LOGGER.debug("Ignoring retained payload on %s", msg.topic)
            return

        payload = _parse_payload(msg.payload, msg.topic)
        if payload is None:
            return

        _LOGGER.debug("%s <- %s", msg.topic, payload)
        self._last_payload = payload
        self._async_note_telemetry(payload)

        try:
            action = self._async_build_action(payload)
        except Exception:  # noqa: BLE001 - a bad payload must not kill the loop
            _LOGGER.exception("Unhandled error while processing %s", payload)
            return

        if action is None:
            return

        self._last_action = action
        async_dispatcher_send(self.hass, SIGNAL_ACTION, action)

    @callback
    def async_process_payload(self, payload: Mapping[str, Any]) -> BilresaAction | None:
        """Process an already decoded payload and dispatch it.

        Exposed for the learn mode and for tests; the MQTT path uses the same
        code.
        """
        self._last_payload = dict(payload)
        self._async_note_telemetry(payload)
        action = self._async_build_action(payload)
        if action is not None:
            self._last_action = action
            async_dispatcher_send(self.hass, SIGNAL_ACTION, action)
        return action

    @callback
    def _async_note_telemetry(self, payload: Mapping[str, Any]) -> None:
        battery = _coerce_int(payload.get(FIELD_BATTERY))
        if battery is not None:
            self._battery = battery
        linkquality = _coerce_int(payload.get(FIELD_LINKQUALITY))
        if linkquality is not None:
            self._linkquality = linkquality

    @callback
    def _async_build_action(self, payload: Mapping[str, Any]) -> BilresaAction | None:
        """Normalise a payload into an action, or None if there is none."""
        raw_action = payload.get(FIELD_ACTION)
        if raw_action is None or raw_action == "":
            # Battery / linkquality only reports arrive on the same topic.
            if not any(key in payload for key in _TELEMETRY_FIELDS):
                _LOGGER.debug("Payload without action on %s: %s", self.topic, payload)
            return None

        if not isinstance(raw_action, str):
            _LOGGER.debug("Non-string action %r on %s", raw_action, self.topic)
            return None

        action = RAW_TO_ACTION.get(raw_action)
        if action is None:
            _LOGGER.debug("Unknown action %r on %s, ignored", raw_action, self.topic)
            return None

        action_group = _coerce_int(payload.get(FIELD_ACTION_GROUP))

        level: int | None = self._level
        previous_level: int | None = None
        delta: int | None = None
        direction: str | None = None

        if action == ACTION_WHEEL:
            wheel = self._async_handle_wheel(payload)
            if wheel is None:
                # Calibration or a repeated level: no event, but the channel
                # information in this payload is still worth keeping.
                self.mode.async_observe(action_group)
                return None
            level, previous_level, delta, direction = wheel

        resolution = self.mode.async_resolve(action, action_group)

        return BilresaAction(
            remote_id=self.remote_id,
            action=action,
            action_base=_base_action(action),
            raw_action=raw_action,
            mode=resolution.mode,
            mode_name=resolution.mode_name,
            mode_source=resolution.mode_source,
            is_mode_cycle=resolution.is_mode_cycle,
            action_group=action_group,
            level=level,
            level_pct=_level_pct(level),
            level_254=_level_254(level),
            previous_level=previous_level,
            delta=delta,
            direction=direction,
            timestamp=dt_util.utcnow(),
            payload=dict(payload),
        )

    @callback
    def _async_handle_wheel(
        self, payload: Mapping[str, Any]
    ) -> tuple[int, int | None, int, str] | None:
        """Return (level, previous, delta, direction) or None to discard."""
        level = _extract_level(payload)
        if level is None:
            _LOGGER.debug("Wheel payload without level on %s: %s", self.topic, payload)
            return None

        previous = self._level
        self._level = level

        if not self._level_calibrated or previous is None:
            # First value after start or reconnect: the wheel level is absolute
            # and device-internal, so firing here would jump the light on every
            # restart.
            self._level_calibrated = True
            _LOGGER.debug("Calibrated wheel of %s to %s", self.remote_id, level)
            return None

        delta = level - previous
        if delta == 0:
            return None

        direction = DIRECTION_UP if delta > 0 else DIRECTION_DOWN
        return level, previous, delta, direction


# --------------------------------------------------------------------------- #
# Payload helpers
# --------------------------------------------------------------------------- #


def _parse_payload(raw: Any, topic: str) -> dict[str, Any] | None:
    """Decode a JSON payload, logging and discarding anything unusable."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            _LOGGER.warning("Non UTF-8 payload on %s, discarded", topic)
            return None

    if not isinstance(raw, str):
        _LOGGER.warning("Unexpected payload type %s on %s", type(raw).__name__, topic)
        return None

    stripped = raw.strip()
    if not stripped:
        return None

    try:
        payload = json.loads(stripped)
    except ValueError as err:
        _LOGGER.warning("Invalid JSON on %s (%s): %s", topic, err, stripped[:200])
        return None

    if not isinstance(payload, dict):
        _LOGGER.debug("Ignoring non-object payload on %s: %s", topic, stripped[:200])
        return None

    return payload


def _extract_level(payload: Mapping[str, Any]) -> int | None:
    """Return the clamped wheel level, mapping the ZCL non-value to 255."""
    for key in (FIELD_ACTION_LEVEL, FIELD_BRIGHTNESS):
        if key not in payload:
            continue
        value = payload[key]
        if value is None:
            return WHEEL_LEVEL_NULL_FALLBACK
        level = _coerce_int(value)
        if level is None:
            _LOGGER.debug("Unusable %s value %r, assuming non-value", key, value)
            return WHEEL_LEVEL_NULL_FALLBACK
        return max(WHEEL_LEVEL_MIN, min(WHEEL_LEVEL_MAX, level))
    return None


def _level_pct(level: int | None) -> int | None:
    """Return the level as a rounded percentage."""
    if level is None:
        return None
    return round(level * 100 / WHEEL_LEVEL_MAX)


def _level_254(level: int | None) -> int | None:
    """Return the level clamped to what light entities accept."""
    if level is None:
        return None
    return min(level, LEVEL_MAX_FOR_LIGHTS)


def _base_action(action: str) -> str:
    """Collapse the click parity into the generic single click."""
    if action in (ACTION_CLICK_ON, ACTION_CLICK_OFF):
        return ACTION_CLICK
    return action
