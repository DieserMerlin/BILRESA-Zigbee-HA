"""Next-mode button for the IKEA BILRESA Remote integration.

The lower button of the remote switches the device-internal channel without
sending anything over Zigbee, so there is no way to advance the mode from
Home Assistant unless we offer it explicitly. This button does that.
"""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .dispatcher import (
    BilresaRemoteEntity,
    async_current_mode,
    async_request_next_mode,
    mode_count,
    remote_subentries,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one next-mode button per configured remote."""
    for subentry in remote_subentries(entry):
        async_add_entities(
            [BilresaNextModeButton(entry, subentry)],
            config_subentry_id=subentry.subentry_id,
        )


class BilresaNextModeButton(BilresaRemoteEntity, ButtonEntity):
    """Advances a remote to its next mode."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "next_mode"

    def __init__(self, entry: ConfigEntry, subentry: ConfigSubentry) -> None:
        """Initialise the next-mode button."""
        super().__init__(entry, subentry, "next_mode")
        self._mode = 1

    async def async_added_to_hass(self) -> None:
        """Pick up the mode the resolver is on."""
        await super().async_added_to_hass()
        current = async_current_mode(self._entry, self._subentry_id)
        if current is not None and 1 <= current <= mode_count(self.subentry):
            self._mode = current

    async def async_press(self) -> None:
        """Switch to the next mode.

        The resolver decides whether it wraps at the last mode; ``self._mode``
        only feeds the fallback used when no resolver can be reached.
        """
        await async_request_next_mode(self.hass, self._entry, self._subentry_id, self._mode)

    @callback
    def handle_mode(self, mode: int) -> None:
        """Track the active mode so the fallback cycling stays in step."""
        if 1 <= mode <= mode_count(self.subentry):
            self._mode = mode
