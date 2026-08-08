"""Repair flows for the IKEA BILRESA Remote integration.

Two issues can be raised at runtime:

``channels_locked``
    A remote is configured to take its mode from the device channels, but in 30
    days of operation it never once sent a group other than the first one. In
    practice that means the physical Touchlink unlock was never performed and
    the lower button does nothing. The fix flow offers the only two useful ways
    out: switch the remote to internal mode switching (works without any
    unlock), or confirm that the unlock has just been done and give it another
    30 days.

``invalid_sequence``
    A stored action sequence does not validate. The dispatcher skips exactly
    that binding and keeps everything else running; the flow is a plain
    acknowledgement that points at the reconfigure dialog.

The option labels carry the full explanation on purpose, so the dialog stays
usable even before the translations catch up.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components.repairs import ConfirmRepairFlow, RepairsFlow
from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)
from homeassistant.util import dt as dt_util

from .const import (
    CONF_MODE_SOURCE,
    DOMAIN,
    ISSUE_CHANNELS_LOCKED,
    ISSUE_INVALID_SEQUENCE,
    MODE_SOURCE_INTERNAL,
    SUBENTRY_TYPE_REMOTE,
)
from .dispatcher import remote_ieee, remote_name, remote_subentries
from .mode import async_get_mode_store

_LOGGER = logging.getLogger(__name__)

CONF_CHOICE = "choice"

CHOICE_INTERNAL = "internal"
CHOICE_RETRY = "retry"
CHOICE_IGNORE = "ignore"

_CHOICES: list[SelectOptionDict] = [
    SelectOptionDict(
        value=CHOICE_INTERNAL,
        label=(
            "Switch this remote to internal mode switching - the mode is then "
            "cycled by a click pattern and works without the Touchlink unlock"
        ),
    ),
    SelectOptionDict(
        value=CHOICE_RETRY,
        label=(
            "I have just unlocked the channels - watch the remote for another "
            "30 days"
        ),
    ),
    SelectOptionDict(
        value=CHOICE_IGNORE,
        label="Leave the configuration untouched and dismiss this warning",
    ),
]

_CHOICE_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_CHOICE, default=CHOICE_INTERNAL): SelectSelector(
            SelectSelectorConfig(options=_CHOICES, mode=SelectSelectorMode.LIST)
        )
    }
)


def _find_remote(
    hass: HomeAssistant, remote_id: str
) -> tuple[ConfigEntry, ConfigSubentry] | None:
    """Return the config entry and subentry of a remote, by IEEE or subentry id."""
    for entry in hass.config_entries.async_entries(DOMAIN):
        for subentry in remote_subentries(entry):
            if remote_id in (remote_ieee(subentry), subentry.subentry_id):
                return entry, subentry
    return None


def _find_subentry(
    hass: HomeAssistant, subentry_id: str
) -> tuple[ConfigEntry, ConfigSubentry] | None:
    """Return the config entry and subentry for a subentry id."""
    for entry in hass.config_entries.async_entries(DOMAIN):
        subentry = entry.subentries.get(subentry_id)
        if subentry is not None and subentry.subentry_type == SUBENTRY_TYPE_REMOTE:
            return entry, subentry
    return None


def _issue_suffix(issue_id: str, prefix: str) -> str:
    """Return the part of an issue id behind its ``<prefix>_`` marker."""
    return issue_id[len(prefix) + 1 :] if issue_id.startswith(f"{prefix}_") else ""


class ChannelsLockedRepairFlow(RepairsFlow):
    """Guide the user out of a remote whose device channels never unlocked."""

    def __init__(self, issue_id: str, data: dict[str, Any] | None) -> None:
        """Remember which remote this flow is about."""
        self._issue_id = issue_id
        self._remote_id = str(
            (data or {}).get("remote_id") or _issue_suffix(issue_id, ISSUE_CHANNELS_LOCKED)
        )

    async def async_step_init(self, user_input: dict[str, str] | None = None) -> FlowResult:
        """Start the flow."""
        return await self.async_step_confirm()

    async def async_step_confirm(
        self, user_input: dict[str, str] | None = None
    ) -> FlowResult:
        """Ask what to do and apply the answer."""
        found = _find_remote(self.hass, self._remote_id)
        if found is None:
            # The remote was deleted while the issue was open.
            ir.async_delete_issue(self.hass, DOMAIN, self._issue_id)
            return self.async_create_entry(title="", data={})

        entry, subentry = found

        if user_input is None:
            return self.async_show_form(
                step_id="confirm",
                data_schema=_CHOICE_SCHEMA,
                description_placeholders={
                    "name": remote_name(subentry),
                    "ieee": remote_ieee(subentry),
                },
            )

        choice = user_input.get(CONF_CHOICE, CHOICE_IGNORE)
        if choice == CHOICE_INTERNAL:
            await self._async_switch_to_internal(entry, subentry)
        elif choice == CHOICE_RETRY:
            await self._async_restart_watch(entry)

        # Finishing the flow removes the issue from the repairs dashboard.
        return self.async_create_entry(title="", data={})

    async def _async_switch_to_internal(
        self, entry: ConfigEntry, subentry: ConfigSubentry
    ) -> None:
        """Move the remote off the device channels."""
        data = {**subentry.data, CONF_MODE_SOURCE: MODE_SOURCE_INTERNAL}
        self.hass.config_entries.async_update_subentry(entry, subentry, data=data)
        _LOGGER.info(
            "Remote %s switched to internal mode switching by a repair flow",
            remote_name(subentry),
        )

    async def _async_restart_watch(self, entry: ConfigEntry) -> None:
        """Give the remote another observation window.

        The observation start lives in the mode store, so it is reset there and
        the entry is reloaded to make the resolver pick it up.
        """
        store = async_get_mode_store(self.hass)
        await store.async_load()
        store.async_update(self._remote_id, device_since=dt_util.utcnow().isoformat())
        self.hass.config_entries.async_schedule_reload(entry.entry_id)


class InvalidSequenceRepairFlow(RepairsFlow):
    """Acknowledge a stored action sequence that does not validate."""

    def __init__(self, issue_id: str, data: dict[str, Any] | None) -> None:
        """Remember which binding this flow is about."""
        self._issue_id = issue_id
        self._data = dict(data or {})

    async def async_step_init(self, user_input: dict[str, str] | None = None) -> FlowResult:
        """Start the flow."""
        return await self.async_step_confirm()

    async def async_step_confirm(
        self, user_input: dict[str, str] | None = None
    ) -> FlowResult:
        """Show the details once and close the issue on confirmation."""
        if user_input is not None:
            return self.async_create_entry(title="", data={})

        placeholders = {
            "remote": str(self._data.get("remote") or self._remote_label()),
            "mode": str(self._data.get("mode") or "?"),
            "action": str(self._data.get("action") or "?"),
            "error": str(self._data.get("error") or ""),
        }
        return self.async_show_form(
            step_id="confirm",
            data_schema=vol.Schema({}),
            description_placeholders=placeholders,
        )

    def _remote_label(self) -> str:
        """Return the remote name derived from the issue id, if possible."""
        suffix = _issue_suffix(self._issue_id, ISSUE_INVALID_SEQUENCE)
        subentry_id = suffix.split("_", 1)[0] if suffix else ""
        found = _find_subentry(self.hass, subentry_id) if subentry_id else None
        return remote_name(found[1]) if found is not None else "?"


async def async_create_fix_flow(
    hass: HomeAssistant, issue_id: str, data: dict[str, Any] | None
) -> RepairsFlow:
    """Return the repair flow that belongs to an issue id."""
    if issue_id.startswith(ISSUE_CHANNELS_LOCKED):
        return ChannelsLockedRepairFlow(issue_id, data)
    if issue_id.startswith(ISSUE_INVALID_SEQUENCE):
        return InvalidSequenceRepairFlow(issue_id, data)
    _LOGGER.debug("No dedicated repair flow for %s, falling back to confirm", issue_id)
    return ConfirmRepairFlow()
