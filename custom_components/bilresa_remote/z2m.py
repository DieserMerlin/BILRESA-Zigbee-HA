"""Thin helpers for talking to Zigbee2MQTT over MQTT.

Two kinds of access are needed by the setup assistant:

* read the retained bridge topics ``bridge/devices`` and ``bridge/groups`` once,
  so the config flow can offer a device list instead of hand typed IEEE
  addresses,
* fire request/response calls on ``bridge/request/group/*`` to create groups and
  manage their members.

Everything here is defensive: every call is bounded by a timeout and every
failure surfaces as a :class:`Z2MError` subclass. Nothing else escapes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final
from uuid import uuid4

from homeassistant.components import mqtt
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError

from .const import (
    COLORS,
    DEFAULT_BASE_TOPIC,
    DOMAIN,
    MODEL_WHEEL,
    SUPPORTED_MODELS,
)

if TYPE_CHECKING:
    from homeassistant.components.mqtt.models import ReceiveMessage

_LOGGER = logging.getLogger(__name__)

#: Seconds to wait for a retained bridge topic. ``bridge/devices`` can be large
#: on busy networks, but it is retained and therefore delivered immediately.
DEFAULT_FETCH_TIMEOUT: Final = 10.0

#: Seconds to wait for a ``bridge/response/...`` answer.
DEFAULT_REQUEST_TIMEOUT: Final = 15.0

#: Seconds to wait for the MQTT integration to become usable.
MQTT_READY_TIMEOUT: Final = 10.0

TOPIC_BRIDGE_DEVICES: Final = "bridge/devices"
TOPIC_BRIDGE_GROUPS: Final = "bridge/groups"

REQUEST_GROUP_ADD: Final = "group/add"
REQUEST_GROUP_REMOVE: Final = "group/remove"
REQUEST_GROUP_MEMBER_ADD: Final = "group/members/add"
REQUEST_GROUP_MEMBER_REMOVE: Final = "group/members/remove"

#: Housing colour guessing. The user keeps the colour in the Zigbee2MQTT
#: ``description`` field, in German or English. Keys must stay within COLORS.
_COLOR_ALIASES: Final[dict[str, tuple[str, ...]]] = {
    "red": ("red", "rot", "rostrot", "rust", "terracotta", "terrakotta", "ruby"),
    "beige": ("beige", "white", "weiss", "cream", "creme", "sand", "ivory", "elfenbein"),
    "green": ("green", "gruen", "teal", "turquoise", "tuerkis", "mint", "olive"),
}

_UMLAUTS: Final = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})
_WORD_RE: Final = re.compile(r"[a-z0-9]+")


class Z2MError(HomeAssistantError):
    """Base class for all Zigbee2MQTT helper failures."""


class Z2MUnavailableError(Z2MError):
    """The MQTT integration is not usable right now."""


class Z2MTimeoutError(Z2MError):
    """Zigbee2MQTT did not answer in time."""


class Z2MResponseError(Z2MError):
    """Zigbee2MQTT answered with an error status."""

    def __init__(self, message: str, *, data: Mapping[str, Any] | None = None) -> None:
        """Store the raw response for diagnostics."""
        super().__init__(message)
        self.data: Mapping[str, Any] = data or {}


# --------------------------------------------------------------------------- #
# Parsed objects
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Z2MRemote:
    """A BILRESA remote as seen by Zigbee2MQTT."""

    ieee: str
    friendly_name: str
    model: str
    #: The user editable Zigbee2MQTT description field.
    description: str = ""
    #: Colour guessed from ``description``; one of ``const.COLORS`` or None.
    suggested_color: str | None = None
    supported: bool = True
    disabled: bool = False

    @property
    def label(self) -> str:
        """Return a human readable label for selectors."""
        if self.friendly_name and self.friendly_name != self.ieee:
            return f"{self.friendly_name} ({self.ieee})"
        return self.ieee


@dataclass(frozen=True, slots=True)
class Z2MGroup:
    """A Zigbee2MQTT group."""

    id: int
    friendly_name: str
    members: tuple[str, ...] = field(default_factory=tuple)

    @property
    def label(self) -> str:
        """Return a human readable label for selectors."""
        return f"{self.friendly_name} ({self.id})"


# --------------------------------------------------------------------------- #
# Colour guessing
# --------------------------------------------------------------------------- #


@callback
def guess_color(description: str | None) -> str | None:
    """Guess a housing colour from a free text description.

    Returns a value from ``const.COLORS`` or None when nothing matches.
    """
    if not description:
        return None
    words = set(_WORD_RE.findall(description.casefold().translate(_UMLAUTS)))
    if not words:
        return None
    for color in COLORS:
        for alias in _COLOR_ALIASES.get(color, (color,)):
            if alias in words:
                return color
    return None


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #


@callback
def parse_remotes(
    devices: Any,
    *,
    models: tuple[str, ...] = SUPPORTED_MODELS,
) -> list[Z2MRemote]:
    """Filter a ``bridge/devices`` payload down to supported remotes."""
    remotes: list[Z2MRemote] = []
    if not isinstance(devices, list):
        return remotes

    for device in devices:
        if not isinstance(device, dict):
            continue
        definition = device.get("definition")
        definition = definition if isinstance(definition, dict) else {}
        model = str(definition.get("model") or device.get("model_id") or "")
        if model not in models:
            continue
        ieee = str(device.get("ieee_address") or "").strip()
        if not ieee:
            continue
        description = str(device.get("description") or "").strip()
        remotes.append(
            Z2MRemote(
                ieee=ieee,
                friendly_name=str(device.get("friendly_name") or ieee),
                model=model or MODEL_WHEEL,
                description=description,
                suggested_color=guess_color(description),
                supported=bool(device.get("supported", True)),
                disabled=bool(device.get("disabled", False)),
            )
        )

    remotes.sort(key=lambda remote: remote.friendly_name.casefold())
    return remotes


@callback
def parse_groups(groups: Any) -> list[Z2MGroup]:
    """Turn a ``bridge/groups`` payload into :class:`Z2MGroup` objects."""
    parsed: list[Z2MGroup] = []
    if not isinstance(groups, list):
        return parsed

    for group in groups:
        if not isinstance(group, dict):
            continue
        raw_id = group.get("id")
        if isinstance(raw_id, bool) or not isinstance(raw_id, (int, float, str)):
            continue
        try:
            group_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        members: list[str] = []
        for member in group.get("members") or ():
            if isinstance(member, dict):
                address = member.get("ieee_address")
                if address:
                    members.append(str(address))
        parsed.append(
            Z2MGroup(
                id=group_id,
                friendly_name=str(group.get("friendly_name") or group_id),
                members=tuple(members),
            )
        )

    parsed.sort(key=lambda group: group.id)
    return parsed


# --------------------------------------------------------------------------- #
# Reading retained bridge topics
# --------------------------------------------------------------------------- #


async def async_fetch_devices(
    hass: HomeAssistant,
    base_topic: str = DEFAULT_BASE_TOPIC,
    *,
    timeout: float = DEFAULT_FETCH_TIMEOUT,
) -> list[dict[str, Any]]:
    """Read the retained ``bridge/devices`` payload once."""
    payload = await _async_read_topic(hass, base_topic, TOPIC_BRIDGE_DEVICES, timeout)
    return payload if isinstance(payload, list) else []


async def async_fetch_groups(
    hass: HomeAssistant,
    base_topic: str = DEFAULT_BASE_TOPIC,
    *,
    timeout: float = DEFAULT_FETCH_TIMEOUT,
) -> list[dict[str, Any]]:
    """Read the retained ``bridge/groups`` payload once."""
    payload = await _async_read_topic(hass, base_topic, TOPIC_BRIDGE_GROUPS, timeout)
    return payload if isinstance(payload, list) else []


async def async_discover_remotes(
    hass: HomeAssistant,
    base_topic: str = DEFAULT_BASE_TOPIC,
    *,
    timeout: float = DEFAULT_FETCH_TIMEOUT,
    models: tuple[str, ...] = SUPPORTED_MODELS,
) -> list[Z2MRemote]:
    """Return the supported remotes known to Zigbee2MQTT."""
    devices = await async_fetch_devices(hass, base_topic, timeout=timeout)
    return parse_remotes(devices, models=models)


async def async_discover_groups(
    hass: HomeAssistant,
    base_topic: str = DEFAULT_BASE_TOPIC,
    *,
    timeout: float = DEFAULT_FETCH_TIMEOUT,
) -> list[Z2MGroup]:
    """Return the groups known to Zigbee2MQTT."""
    return parse_groups(await async_fetch_groups(hass, base_topic, timeout=timeout))


# --------------------------------------------------------------------------- #
# Group management
# --------------------------------------------------------------------------- #


async def async_create_group(
    hass: HomeAssistant,
    base_topic: str,
    friendly_name: str,
    *,
    group_id: int | None = None,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> Z2MGroup:
    """Create a Zigbee group and return it.

    ``group_id`` should be one of the BILRESA channel ids when the group is
    meant to be driven by the remote itself.
    """
    payload: dict[str, Any] = {"friendly_name": friendly_name}
    if group_id is not None:
        payload["id"] = int(group_id)

    data = await async_request(hass, base_topic, REQUEST_GROUP_ADD, payload, timeout=timeout)
    created_id = data.get("id", group_id)
    try:
        resolved_id = int(created_id)
    except (TypeError, ValueError) as err:
        raise Z2MResponseError(
            f"Zigbee2MQTT created a group without a usable id: {data}", data=data
        ) from err
    return Z2MGroup(
        id=resolved_id,
        friendly_name=str(data.get("friendly_name") or friendly_name),
    )


async def async_remove_group(
    hass: HomeAssistant,
    base_topic: str,
    group: str | int,
    *,
    force: bool = False,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> None:
    """Delete a Zigbee group."""
    payload: dict[str, Any] = {"id": str(group)}
    if force:
        payload["force"] = True
    await async_request(hass, base_topic, REQUEST_GROUP_REMOVE, payload, timeout=timeout)


async def async_add_group_member(
    hass: HomeAssistant,
    base_topic: str,
    group: str | int,
    device: str,
    *,
    endpoint: str | int | None = None,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> None:
    """Add a device (or one of its endpoints) to a group."""
    await async_request(
        hass,
        base_topic,
        REQUEST_GROUP_MEMBER_ADD,
        _member_payload(group, device, endpoint),
        timeout=timeout,
    )


async def async_remove_group_member(
    hass: HomeAssistant,
    base_topic: str,
    group: str | int,
    device: str,
    *,
    endpoint: str | int | None = None,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> None:
    """Remove a device (or one of its endpoints) from a group."""
    await async_request(
        hass,
        base_topic,
        REQUEST_GROUP_MEMBER_REMOVE,
        _member_payload(group, device, endpoint),
        timeout=timeout,
    )


def _member_payload(group: str | int, device: str, endpoint: str | int | None) -> dict[str, Any]:
    payload: dict[str, Any] = {"group": str(group), "device": device}
    if endpoint is not None:
        payload["endpoint"] = endpoint
    return payload


# --------------------------------------------------------------------------- #
# Plumbing
# --------------------------------------------------------------------------- #


async def async_request(
    hass: HomeAssistant,
    base_topic: str,
    path: str,
    payload: Mapping[str, Any],
    *,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> dict[str, Any]:
    """Run one ``bridge/request/<path>`` call and return its ``data`` block.

    Raises :class:`Z2MUnavailableError`, :class:`Z2MTimeoutError` or
    :class:`Z2MResponseError`; nothing else leaves this function.
    """
    await _async_ensure_mqtt(hass)

    base = _normalise_base_topic(base_topic)
    request_topic = f"{base}/bridge/request/{path}"
    response_topic = f"{base}/bridge/response/{path}"
    transaction = f"{DOMAIN}_{uuid4().hex[:12]}"

    future: asyncio.Future[dict[str, Any]] = hass.loop.create_future()

    @callback
    def _handle(msg: ReceiveMessage) -> None:
        if future.done():
            return
        data = _decode_json(msg.payload, msg.topic)
        if not isinstance(data, dict):
            return
        answer = data.get("transaction")
        if answer is not None and answer != transaction:
            # Another client's request; ignore it.
            return
        future.set_result(data)

    unsub = await mqtt.async_subscribe(hass, response_topic, _handle)
    try:
        await mqtt.async_publish(
            hass,
            request_topic,
            json.dumps({**dict(payload), "transaction": transaction}),
            qos=0,
            retain=False,
        )
        async with asyncio.timeout(timeout):
            response = await future
    except TimeoutError as err:
        raise Z2MTimeoutError(
            f"No answer from Zigbee2MQTT on {response_topic} within {timeout:.0f}s"
        ) from err
    except HomeAssistantError:
        raise
    except Exception as err:
        raise Z2MError(f"Zigbee2MQTT request {path} failed: {err}") from err
    finally:
        unsub()

    if response.get("status") != "ok":
        message = str(response.get("error") or f"Zigbee2MQTT rejected {path}")
        raise Z2MResponseError(message, data=response)

    data = response.get("data")
    return data if isinstance(data, dict) else {}


async def _async_read_topic(
    hass: HomeAssistant,
    base_topic: str,
    suffix: str,
    timeout: float,
) -> Any:
    """Subscribe to a retained topic, take the first payload, unsubscribe."""
    await _async_ensure_mqtt(hass)

    topic = f"{_normalise_base_topic(base_topic)}/{suffix}"
    future: asyncio.Future[Any] = hass.loop.create_future()

    @callback
    def _handle(msg: ReceiveMessage) -> None:
        if future.done():
            return
        future.set_result(_decode_json(msg.payload, msg.topic))

    unsub = await mqtt.async_subscribe(hass, topic, _handle)
    try:
        async with asyncio.timeout(timeout):
            return await future
    except TimeoutError as err:
        raise Z2MTimeoutError(
            f"No retained payload on {topic} within {timeout:.0f}s. Is the base "
            "topic correct and Zigbee2MQTT running?"
        ) from err
    except HomeAssistantError:
        raise
    except Exception as err:
        raise Z2MError(f"Could not read {topic}: {err}") from err
    finally:
        unsub()


async def _async_ensure_mqtt(hass: HomeAssistant) -> None:
    """Raise Z2MUnavailableError unless the MQTT client is usable."""
    try:
        async with asyncio.timeout(MQTT_READY_TIMEOUT):
            available = await mqtt.async_wait_for_mqtt_client(hass)
    except TimeoutError as err:
        raise Z2MUnavailableError("MQTT client did not become available") from err
    except Exception as err:
        raise Z2MUnavailableError(f"MQTT integration is unavailable: {err}") from err
    if not available:
        raise Z2MUnavailableError("MQTT integration is unavailable")


def _normalise_base_topic(base_topic: str | None) -> str:
    """Return the base topic without stray slashes."""
    return (base_topic or DEFAULT_BASE_TOPIC).strip().strip("/") or DEFAULT_BASE_TOPIC


def _decode_json(raw: Any, topic: str) -> Any:
    """Decode a payload, returning None instead of raising."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            _LOGGER.warning("Non UTF-8 payload on %s", topic)
            return None
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return json.loads(raw)
    except ValueError as err:
        _LOGGER.warning("Invalid JSON on %s: %s", topic, err)
        return None
