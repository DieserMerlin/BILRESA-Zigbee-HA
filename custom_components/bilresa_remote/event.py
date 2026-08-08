"""Event entity for the IKEA BILRESA Remote integration.

One entity per remote. This is the escape hatch: everything the integration
knows about a press is published here, so users can build their own automations
with the ``event.received`` trigger instead of the built-in action mappings.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.event import EventDeviceClass, EventEntity
from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import (
    ACTION_WHEEL,
    ATTR_ACTION,
    ATTR_ACTION_GROUP,
    ATTR_DELTA,
    ATTR_DIRECTION,
    ATTR_LEVEL,
    ATTR_LEVEL_PCT,
    ATTR_MODE,
    ATTR_MODE_NAME,
    ATTR_MODE_SOURCE,
    ATTR_PREVIOUS_LEVEL,
    EVENT_TYPES,
    WHEEL_LEVEL_MAX,
)
from .dispatcher import (
    BilresaRemoteEntity,
    event_value,
    mode_label,
    mode_source,
    remote_subentries,
    resolve_action,
)

_LOGGER = logging.getLogger(__name__)

_WHEEL_UP = "wheel_up"
_WHEEL_DOWN = "wheel_down"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one event entity per configured remote."""
    for subentry in remote_subentries(entry):
        async_add_entities(
            [BilresaEventEntity(entry, subentry)],
            config_subentry_id=subentry.subentry_id,
        )


class BilresaEventEntity(BilresaRemoteEntity, EventEntity):
    """Publishes every normalised remote action as an event."""

    _attr_device_class = EventDeviceClass.BUTTON
    _attr_event_types = list(EVENT_TYPES)
    #: The event entity *is* the remote, so it carries the device name.
    _attr_name = None

    def __init__(self, entry: ConfigEntry, subentry: ConfigSubentry) -> None:
        """Initialise the event entity."""
        super().__init__(entry, subentry, "event")

    @callback
    def handle_action(self, event: Any) -> None:
        """Fire the event that matches an incoming action."""
        raw_action = event_value(event, ATTR_ACTION)
        if not raw_action:
            return
        subentry = self.subentry
        action = resolve_action(str(raw_action), subentry)

        level = _int(event_value(event, ATTR_LEVEL))
        previous = _int(event_value(event, ATTR_PREVIOUS_LEVEL))
        delta = _int(event_value(event, ATTR_DELTA))
        if delta is None and level is not None and previous is not None:
            delta = level - previous
        direction = event_value(event, ATTR_DIRECTION)
        if direction is None and delta:
            direction = "up" if delta > 0 else "down"

        if action == ACTION_WHEEL:
            if not direction:
                # A wheel report without movement carries no information; the
                # coordinator also uses the first value after start to calibrate.
                return
            event_type = _WHEEL_UP if direction == "up" else _WHEEL_DOWN
        else:
            event_type = action

        if event_type not in EVENT_TYPES:
            _LOGGER.debug("Ignoring unsupported event type %s", event_type)
            return

        level_pct = _int(event_value(event, ATTR_LEVEL_PCT))
        if level_pct is None and level is not None:
            level_pct = round(level / WHEEL_LEVEL_MAX * 100)
        mode = _int(event_value(event, ATTR_MODE)) or 1

        self._trigger_event(
            event_type,
            {
                ATTR_MODE: mode,
                ATTR_MODE_NAME: event_value(event, ATTR_MODE_NAME)
                or mode_label(subentry, mode),
                ATTR_MODE_SOURCE: event_value(event, ATTR_MODE_SOURCE)
                or mode_source(subentry),
                ATTR_LEVEL: level,
                ATTR_LEVEL_PCT: level_pct,
                ATTR_PREVIOUS_LEVEL: previous,
                ATTR_DELTA: delta,
                ATTR_DIRECTION: direction,
                ATTR_ACTION_GROUP: _int(event_value(event, ATTR_ACTION_GROUP)),
            },
        )
        self.async_write_ha_state()


def _int(value: Any) -> int | None:
    """Best effort int conversion that never raises."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
