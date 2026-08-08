"""Diagnostic sensors for the IKEA BILRESA Remote integration.

Two per remote: the last action that was received, and the current absolute
wheel level. Both are diagnostic — they exist to make the protocol observable,
not to be automated on (use the event entity for that).
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.util import dt as dt_util

from .const import (
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
    ATTR_PREVIOUS_LEVEL,
    EVENT_TYPES,
    WHEEL_LEVEL_MAX,
    WHEEL_LEVEL_MIN,
)
from .dispatcher import (
    BilresaRemoteEntity,
    event_value,
    mode_label,
    remote_subentries,
    resolve_action,
)

_LOGGER = logging.getLogger(__name__)

#: Not in const.py; local to the diagnostic sensor.
ATTR_TIMESTAMP = "timestamp"

_LEVEL_LIGHT_MAX = 254
_WHEEL_UP = "wheel_up"
_WHEEL_DOWN = "wheel_down"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the diagnostic sensors of every configured remote."""
    for subentry in remote_subentries(entry):
        async_add_entities(
            [
                BilresaLastActionSensor(entry, subentry),
                BilresaWheelLevelSensor(entry, subentry),
            ],
            config_subentry_id=subentry.subentry_id,
        )


def _int(value: Any) -> int | None:
    """Best effort int conversion that never raises."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class BilresaLastActionSensor(BilresaRemoteEntity, SensorEntity, RestoreEntity):
    """The last normalised action received from a remote."""

    _attr_device_class = SensorDeviceClass.ENUM
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_options = list(EVENT_TYPES)
    _attr_translation_key = "last_action"

    def __init__(self, entry: ConfigEntry, subentry: ConfigSubentry) -> None:
        """Initialise the last action sensor."""
        super().__init__(entry, subentry, "last_action")
        self._attr_native_value: str | None = None
        self._attr_extra_state_attributes: dict[str, Any] = {}

    async def async_added_to_hass(self) -> None:
        """Restore the last action seen before the restart."""
        await super().async_added_to_hass()
        if (last_state := await self.async_get_last_state()) is None:
            return
        if last_state.state in self._attr_options:
            self._attr_native_value = last_state.state
            self._attr_extra_state_attributes = {
                key: value
                for key, value in last_state.attributes.items()
                if key
                in (
                    ATTR_TIMESTAMP,
                    ATTR_MODE,
                    ATTR_MODE_NAME,
                    ATTR_ACTION_GROUP,
                )
            }

    @callback
    def handle_action(self, event: Any) -> None:
        """Record the action and when it happened."""
        raw_action = event_value(event, ATTR_ACTION)
        if not raw_action:
            return
        subentry = self.subentry
        action = resolve_action(str(raw_action), subentry)

        if action == ACTION_WHEEL:
            direction = event_value(event, ATTR_DIRECTION)
            delta = _int(event_value(event, ATTR_DELTA))
            if not direction and delta:
                direction = "up" if delta > 0 else "down"
            if not direction:
                return
            action = _WHEEL_UP if direction == "up" else _WHEEL_DOWN

        if action not in self._attr_options:
            _LOGGER.debug("Ignoring unsupported action %s", action)
            return

        mode = _int(event_value(event, ATTR_MODE)) or 1
        self._attr_native_value = action
        self._attr_extra_state_attributes = {
            ATTR_TIMESTAMP: dt_util.utcnow().isoformat(),
            ATTR_MODE: mode,
            ATTR_MODE_NAME: event_value(event, ATTR_MODE_NAME)
            or mode_label(subentry, mode),
            ATTR_ACTION_GROUP: _int(event_value(event, ATTR_ACTION_GROUP)),
        }
        self.async_write_ha_state()


class BilresaWheelLevelSensor(BilresaRemoteEntity, SensorEntity, RestoreEntity):
    """The absolute scroll wheel level of a remote.

    The value is device-internal and shared across all three channels, so it is
    reported per remote, never per mode.
    """

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_translation_key = "wheel_level"

    def __init__(self, entry: ConfigEntry, subentry: ConfigSubentry) -> None:
        """Initialise the wheel level sensor."""
        super().__init__(entry, subentry, "wheel_level")
        self._attr_native_value: int | None = None
        self._attr_extra_state_attributes: dict[str, Any] = {}

    async def async_added_to_hass(self) -> None:
        """Restore the last known wheel level."""
        await super().async_added_to_hass()
        if (last_state := await self.async_get_last_state()) is None:
            return
        if (restored := _int(last_state.state)) is not None:
            self._attr_native_value = restored

    @callback
    def handle_action(self, event: Any) -> None:
        """Update the level whenever the wheel reports a new absolute value."""
        raw_action = event_value(event, ATTR_ACTION)
        if raw_action != ACTION_WHEEL:
            return
        level = _int(event_value(event, ATTR_LEVEL))
        if level is None:
            return
        level = max(WHEEL_LEVEL_MIN, min(level, WHEEL_LEVEL_MAX))

        previous = _int(event_value(event, ATTR_PREVIOUS_LEVEL))
        delta = _int(event_value(event, ATTR_DELTA))
        if delta is None and previous is not None:
            delta = level - previous
        direction = event_value(event, ATTR_DIRECTION)
        if direction is None and delta:
            direction = "up" if delta > 0 else "down"
        level_pct = _int(event_value(event, ATTR_LEVEL_PCT))
        if level_pct is None:
            level_pct = round(level / WHEEL_LEVEL_MAX * 100)
        level_254 = _int(event_value(event, ATTR_LEVEL_254))
        if level_254 is None:
            level_254 = min(level, _LEVEL_LIGHT_MAX)

        self._attr_native_value = level
        self._attr_extra_state_attributes = {
            ATTR_LEVEL_PCT: level_pct,
            ATTR_LEVEL_254: level_254,
            ATTR_PREVIOUS_LEVEL: previous,
            ATTR_DELTA: delta,
            ATTR_DIRECTION: direction,
        }
        self.async_write_ha_state()
