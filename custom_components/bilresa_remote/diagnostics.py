"""Diagnostics support for the IKEA BILRESA Remote integration.

The download is meant to be pasted into a GitHub issue, so it has two jobs:
answer every question the bug template asks, and leak nothing that identifies
the user's home. Config data is redacted, IEEE addresses are masked down to a
correlatable stub, and the raw Zigbee2MQTT payloads are included verbatim --
they are the whole point of this file, because every open protocol question in
this project was decided by looking at them.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntry

from . import BilresaConfigEntry, BilresaData, RemoteRuntime, bridge_device_id
from .const import (
    CONF_IEEE,
    CONF_MAPPINGS,
    CONF_SEQUENCE,
    DOMAIN,
    SUBENTRY_TYPE_REMOTE,
)

#: Keys that never belong in a public bug report.
TO_REDACT: set[str] = {
    "access_token",
    "api_key",
    "email",
    "host",
    "latitude",
    "longitude",
    "mac",
    "password",
    "token",
    "username",
}


def _mask_ieee(value: Any) -> str | None:
    """Mask an IEEE address but keep it correlatable across the report."""
    if value is None:
        return None
    text = str(value)
    if len(text) <= 10:
        return text
    return f"{text[:6]}{'*' * (len(text) - 10)}{text[-4:]}"


def _sequence_summary(raw: Any) -> dict[str, Any]:
    """Describe one stored binding without dumping the user's whole home."""
    if isinstance(raw, dict):
        sequence = raw.get(CONF_SEQUENCE)
        extra = {key: value for key, value in raw.items() if key != CONF_SEQUENCE}
    else:
        sequence, extra = raw, {}

    if sequence is None:
        steps: list[Any] = []
    elif isinstance(sequence, list):
        steps = sequence
    else:
        steps = [sequence]

    return {
        "steps": len(steps),
        "step_types": [_step_type(step) for step in steps],
        "options": async_redact_data(extra, TO_REDACT),
    }


def _step_type(step: Any) -> str:
    """Return the kind of one action step (``action``, ``delay``, ...)."""
    if not isinstance(step, dict):
        return type(step).__name__
    for key in (
        "action",
        "service",
        "delay",
        "choose",
        "if",
        "repeat",
        "wait_template",
        "wait_for_trigger",
        "event",
        "scene",
        "stop",
        "variables",
        "parallel",
    ):
        if key in step:
            value = step.get(key)
            return f"{key}: {value}" if key in ("action", "service") else key
    return "unknown"


def _mappings_summary(data: dict[str, Any]) -> dict[str, Any]:
    """Summarise the configured action mappings per mode."""
    mappings = data.get(CONF_MAPPINGS)
    if not isinstance(mappings, dict):
        mappings = data.get("modes")
    if not isinstance(mappings, dict):
        return {}
    return {
        str(mode_key): {str(action): _sequence_summary(raw) for action, raw in bindings.items()}
        for mode_key, bindings in mappings.items()
        if isinstance(bindings, dict)
    }


def _subentry_diagnostics(entry: BilresaConfigEntry) -> list[dict[str, Any]]:
    """Return the redacted configuration of every remote subentry."""
    result: list[dict[str, Any]] = []
    for subentry in entry.subentries.values():
        data = dict(subentry.data)
        ieee = data.pop(CONF_IEEE, None)
        data.pop(CONF_MAPPINGS, None)
        data.pop("modes", None)
        result.append(
            {
                "subentry_id": subentry.subentry_id,
                "subentry_type": subentry.subentry_type,
                "title": subentry.title,
                "ieee": _mask_ieee(ieee),
                "config": async_redact_data(data, TO_REDACT),
                "mappings": _mappings_summary(dict(subentry.data)),
            }
        )
    return result


def _remote_state(runtime: RemoteRuntime) -> dict[str, Any]:
    """Return the live state of one remote."""
    coordinator = runtime.coordinator
    resolver = runtime.mode
    last = coordinator.last_action

    return {
        "subentry_id": runtime.subentry_id,
        "ieee": _mask_ieee(runtime.ieee),
        "topic": f"{runtime.config.base_topic}/{_mask_ieee(runtime.ieee)}",
        "mode": {
            "current": resolver.current,
            "name": resolver.mode_name,
            "count": resolver.mode_count,
            "configured_source": resolver.config.source,
            "effective_source": resolver.mode_source,
            "cycle_action": resolver.cycle_action,
            "cycle_wrap": resolver.config.cycle_wrap,
            "group_ids": list(resolver.config.group_ids),
            "device_channels_seen": resolver.device_channels_seen,
        },
        "options": {
            "split_single_click": runtime.config.split_single_click,
            "modeless_multiclick": runtime.config.modeless_multiclick,
            "wheel_throttle_ms": runtime.config.wheel_throttle_ms,
            "color": runtime.config.color,
        },
        "telemetry": {
            "battery": coordinator.battery,
            "linkquality": coordinator.linkquality,
            "wheel_level": coordinator.wheel_level,
        },
        "last_action": None
        if last is None
        else {
            "action": last.action,
            "raw_action": last.raw_action,
            "mode": last.mode,
            "action_group": last.action_group,
            "level": last.level,
            "previous_level": last.previous_level,
            "delta": last.delta,
            "direction": last.direction,
            "at": last.timestamp.isoformat(),
        },
        "last_payload": coordinator.last_payload,
        "recent_payloads": list(runtime.history),
    }


def _runtime(entry: BilresaConfigEntry) -> BilresaData | None:
    """Return the runtime data if the entry is loaded."""
    data = getattr(entry, "runtime_data", None)
    return data if isinstance(data, BilresaData) else None


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: BilresaConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for the whole integration."""
    data = _runtime(entry)

    return {
        "entry": {
            "version": entry.version,
            "minor_version": entry.minor_version,
            "state": str(entry.state),
            "data": async_redact_data(dict(entry.data), TO_REDACT),
            "options": async_redact_data(dict(entry.options), TO_REDACT),
            "subentry_counts": _subentry_counts(entry),
        },
        "subentries": _subentry_diagnostics(entry),
        "remotes": []
        if data is None
        else [_remote_state(runtime) for runtime in data.remotes.values()],
    }


async def async_get_device_diagnostics(
    hass: HomeAssistant, entry: BilresaConfigEntry, device: DeviceEntry
) -> dict[str, Any]:
    """Return diagnostics for a single remote (or the bridge device)."""
    data = _runtime(entry)
    identifiers = {identifier for domain, identifier in device.identifiers if domain == DOMAIN}

    if bridge_device_id(entry) in identifiers or data is None:
        return await async_get_config_entry_diagnostics(hass, entry)

    for identifier in identifiers:
        runtime = data.resolve(identifier)
        if runtime is None:
            continue
        subentry = entry.subentries.get(runtime.subentry_id)
        return {
            "config": None
            if subentry is None
            else next(
                (
                    item
                    for item in _subentry_diagnostics(entry)
                    if item["subentry_id"] == runtime.subentry_id
                ),
                None,
            ),
            "state": _remote_state(runtime),
        }

    return {"error": "device does not belong to a configured remote"}


def _subentry_counts(entry: BilresaConfigEntry) -> dict[str, int]:
    """Return how many subentries of each type exist."""
    counts: dict[str, int] = {SUBENTRY_TYPE_REMOTE: 0}
    for subentry in entry.subentries.values():
        counts[subentry.subentry_type] = counts.get(subentry.subentry_type, 0) + 1
    return counts
