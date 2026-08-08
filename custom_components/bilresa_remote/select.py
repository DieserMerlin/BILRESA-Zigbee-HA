"""Mode select for the IKEA BILRESA Remote integration.

One writable select per remote. The remote itself never announces a channel
change over Zigbee, so this entity is both the display and the manual override
of the active mode. It restores its value across restarts, which makes it the
persistence layer for the mode state (the mode resolver keeps the runtime copy).
"""

from __future__ import annotations

import logging

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .dispatcher import (
    BilresaRemoteEntity,
    async_current_mode,
    async_request_mode,
    mode_count,
    mode_names,
    remote_subentries,
)

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one mode select per configured remote."""
    for subentry in remote_subentries(entry):
        async_add_entities(
            [BilresaModeSelect(entry, subentry)],
            config_subentry_id=subentry.subentry_id,
        )


class BilresaModeSelect(BilresaRemoteEntity, SelectEntity, RestoreEntity):
    """The currently active mode of one remote."""

    _attr_translation_key = "mode"

    def __init__(self, entry: ConfigEntry, subentry: ConfigSubentry) -> None:
        """Initialise the mode select."""
        super().__init__(entry, subentry, "mode")
        self._mode = 1

    @property
    def options(self) -> list[str]:
        """Return the configured mode names.

        Read from the live subentry so a reconfigure is picked up without a
        reload of the config entry.
        """
        return mode_names(self.subentry)

    @property
    def current_option(self) -> str | None:
        """Return the label of the active mode."""
        options = self.options
        index = self._mode - 1
        if 0 <= index < len(options):
            return options[index]
        return options[0] if options else None

    async def async_added_to_hass(self) -> None:
        """Restore the mode and hand it back to the mode resolver."""
        await super().async_added_to_hass()
        options = self.options
        last_state = await self.async_get_last_state()

        if last_state is not None and last_state.state in options:
            self._mode = options.index(last_state.state) + 1
            self.async_write_ha_state()
            # The select is the authority across restarts; seed the resolver
            # with what we restored.
            await async_request_mode(
                self.hass, self._entry, self._subentry_id, self._mode
            )
            return

        # Nothing usable to restore -- a first start, or the mode was renamed
        # since the state was written. Show what the resolver restored from its
        # own store instead of silently claiming mode 1.
        current = async_current_mode(self._entry, self._subentry_id)
        if current is not None and 1 <= current <= len(options):
            self._mode = current
        self.async_write_ha_state()

    async def async_select_option(self, option: str) -> None:
        """Switch the remote to the selected mode."""
        options = self.options
        if option not in options:
            raise ValueError(f"Unknown mode {option!r} for {self.entity_id}")
        mode = options.index(option) + 1
        self._mode = mode
        self.async_write_ha_state()
        await async_request_mode(self.hass, self._entry, self._subentry_id, mode)

    @callback
    def handle_mode(self, mode: int) -> None:
        """Follow a mode change reported by the resolver."""
        count = mode_count(self.subentry)
        if not 1 <= mode <= count:
            _LOGGER.debug("Ignoring out of range mode %s", mode)
            return
        if mode == self._mode:
            return
        self._mode = mode
        self.async_write_ha_state()
