"""The IKEA BILRESA Remote integration.

This module is the frame. It wires the three runtime pieces together --
:mod:`.coordinator` (MQTT ingestion), :mod:`.mode` (which of the three internal
channels is active) and :mod:`.dispatcher` (building and running the configured
scripts) -- owns the device registry entries, serves the housing illustrations
used by the config flow and exposes the ``set_mode`` / ``next_mode`` services.

Two design decisions from the design document are implemented here and are worth
spelling out:

* **No entry reload on option changes.** A remote can hold dozens of action
  mappings; reloading the config entry on every edit would tear down the MQTT
  subscriptions and every entity. The update listener therefore diffs and
  rebuilds only what changed, and falls back to a real reload solely for
  structural changes (a remote added or removed, or a different base topic).
* **One device per remote, plus a service device as the bridge anchor.** The
  devices are deliberately *not* merged with the Zigbee2MQTT MQTT devices: a
  device can be linked to a config entry or to a config subentry, never to both.
"""

from __future__ import annotations

import logging
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from inspect import isawaitable
from pathlib import Path
from typing import Any, Final

import voluptuous as vol

from homeassistant.components import mqtt
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry, ConfigEntryState, ConfigSubentry
from homeassistant.const import ATTR_DEVICE_ID, Platform
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import ConfigEntryNotReady, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import service as service_helper
from homeassistant.helpers.device_registry import DeviceEntry, DeviceEntryType
from homeassistant.helpers.typing import ConfigType
from homeassistant.util import dt as dt_util

from .const import (
    ATTR_ACTION,
    ATTR_ACTION_GROUP,
    ATTR_MODE,
    ATTR_MODE_NAME,
    CONF_BASE_TOPIC,
    DEFAULT_BASE_TOPIC,
    DOMAIN,
    IMAGE_PATH,
    MANUFACTURER,
    MODEL_WHEEL,
    MODEL_WHEEL_NAME,
)
from .coordinator import BilresaAction, BilresaCoordinator, RemoteConfig, async_subscribe_actions
from .dispatcher import BilresaDispatcher, remote_ieee, remote_name, remote_subentries
from .mode import BilresaModeStore, ModeResolver, async_get_mode_store

_LOGGER = logging.getLogger(__name__)

PLATFORMS: Final = [Platform.EVENT, Platform.SELECT, Platform.SENSOR, Platform.BUTTON]

CONFIG_SCHEMA: Final = cv.config_entry_only_config_schema(DOMAIN)

#: Version scaffold. ``version`` is bumped for changes that cannot be expressed
#: as a forward compatible addition, ``minor_version`` for everything else.
CONFIG_ENTRY_VERSION: Final = 1
CONFIG_ENTRY_MINOR_VERSION: Final = 1

#: Per subentry schema marker (design doc 3.3). Not in const.py; see the module
#: report. Kept next to the migration code that is the only consumer.
CONF_SCHEMA_VERSION: Final = "schema_version"
SUBENTRY_SCHEMA_VERSION: Final = 1

SERVICE_SET_MODE: Final = "set_mode"
SERVICE_NEXT_MODE: Final = "next_mode"
ATTR_STEP: Final = "step"

#: How many raw payloads per remote the diagnostics download may show.
PAYLOAD_HISTORY: Final = 25

#: Directory holding the housing illustrations served under ``IMAGE_PATH``.
IMAGE_DIR: Final = Path(__file__).parent / "www" / "images"

_IMAGES_REGISTERED: Final = f"{DOMAIN}_images_registered"
_SERVICES_REGISTERED: Final = f"{DOMAIN}_services_registered"


# --------------------------------------------------------------------------- #
# Runtime data
# --------------------------------------------------------------------------- #

#: The config entry of this integration always carries :class:`BilresaData`.
type BilresaConfigEntry = ConfigEntry[BilresaData]


@dataclass(slots=True)
class RemoteRuntime:
    """Everything the integration holds for one configured remote.

    The attribute names are part of the internal contract: ``dispatcher.py``
    locates the mode resolver through ``BilresaData.remotes[...].mode``.
    """

    subentry_id: str
    ieee: str
    name: str
    config: RemoteConfig
    coordinator: BilresaCoordinator
    mode: ModeResolver
    history: deque[dict[str, Any]] = field(
        default_factory=lambda: deque(maxlen=PAYLOAD_HISTORY)
    )


@dataclass(slots=True)
class BilresaData:
    """Runtime data of the single config entry."""

    entry: BilresaConfigEntry
    dispatcher: BilresaDispatcher
    base_topic: str = DEFAULT_BASE_TOPIC
    remotes: dict[str, RemoteRuntime] = field(default_factory=dict)
    structure: tuple[Any, ...] = ()

    @callback
    def remote_by_ieee(self, ieee: str) -> RemoteRuntime | None:
        """Return the runtime of a remote by its hardware address."""
        for runtime in self.remotes.values():
            if runtime.ieee == ieee:
                return runtime
        return None

    @callback
    def resolve(self, identifier: str) -> RemoteRuntime | None:
        """Return a remote runtime by subentry id or hardware address."""
        return self.remotes.get(identifier) or self.remote_by_ieee(identifier)

    @callback
    def async_record(self, action: BilresaAction) -> None:
        """Keep the last raw payloads of a remote for the diagnostics download."""
        runtime = self.resolve(action.remote_id)
        if runtime is None:
            return
        runtime.history.append(
            {
                "at": dt_util.utcnow().isoformat(),
                ATTR_ACTION: action.action,
                "raw_action": action.raw_action,
                ATTR_MODE: action.mode,
                ATTR_MODE_NAME: action.mode_name,
                ATTR_ACTION_GROUP: action.action_group,
                "payload": dict(action.payload),
            }
        )


# --------------------------------------------------------------------------- #
# Static image hosting
# --------------------------------------------------------------------------- #


async def async_register_images(hass: HomeAssistant) -> None:
    """Serve the housing illustrations under :data:`~.const.IMAGE_PATH`.

    Public on purpose: the config flow shows the images in its tutorial steps
    and runs before any config entry exists, so it has to be able to trigger the
    registration itself. aiohttp raises on a duplicate registration, hence the
    guard -- calling this more than once is safe.
    """
    if hass.data.get(_IMAGES_REGISTERED):
        return
    hass.data[_IMAGES_REGISTERED] = True

    if not IMAGE_DIR.is_dir():
        _LOGGER.warning("Image directory %s is missing, illustrations disabled", IMAGE_DIR)
        return

    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(IMAGE_PATH, str(IMAGE_DIR), False)]
        )
    except Exception:  # noqa: BLE001 - missing pictures must never block setup
        _LOGGER.exception("Could not serve the illustrations from %s", IMAGE_DIR)
        return

    _LOGGER.debug("Serving %s from %s", IMAGE_PATH, IMAGE_DIR)


# --------------------------------------------------------------------------- #
# Setup / teardown
# --------------------------------------------------------------------------- #


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the integration-wide parts that do not need a config entry."""
    await async_register_images(hass)
    _async_register_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: BilresaConfigEntry) -> bool:
    """Set up the BILRESA integration from its config entry."""
    await async_register_images(hass)
    _async_register_services(hass)

    if not await mqtt.async_wait_for_mqtt_client(hass):
        # Not an error: MQTT may simply still be starting up.
        raise ConfigEntryNotReady("The MQTT integration is not available yet")

    base_topic = _base_topic(entry)
    store = async_get_mode_store(hass)
    await store.async_load()

    data = BilresaData(
        entry=entry,
        dispatcher=BilresaDispatcher(hass, entry),
        base_topic=base_topic,
        structure=_structure(entry, base_topic),
    )
    entry.runtime_data = data

    try:
        for subentry in remote_subentries(entry):
            runtime = await _async_setup_remote(hass, subentry, base_topic, store)
            if runtime is not None:
                data.remotes[subentry.subentry_id] = runtime

        _async_register_devices(hass, entry)
        _async_cleanup_devices(hass, entry)
        await data.dispatcher.async_setup()
    except Exception:
        await _async_shutdown(data)
        raise

    entry.async_on_unload(async_subscribe_actions(hass, None, data.async_record))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    _LOGGER.debug(
        "Set up %s remote(s) on base topic %s", len(data.remotes), base_topic
    )
    return True


async def _async_setup_remote(
    hass: HomeAssistant,
    subentry: ConfigSubentry,
    base_topic: str,
    store: BilresaModeStore,
) -> RemoteRuntime | None:
    """Build coordinator and mode resolver for one remote subentry."""
    try:
        config = RemoteConfig.from_subentry(subentry.data, base_topic=base_topic)
    except ValueError as err:
        # A broken subentry costs the user that one remote, not the integration.
        _LOGGER.error("Skipping remote %s: %s", subentry.title, err)
        return None

    resolver = ModeResolver(hass, config.remote_id, config.mode, store=store)
    coordinator = BilresaCoordinator(hass, config, mode_resolver=resolver)
    try:
        await coordinator.async_start()
    except Exception:
        # The resolver may already have armed its channel probe timer.
        await coordinator.async_stop()
        raise

    return RemoteRuntime(
        subentry_id=subentry.subentry_id,
        ieee=config.remote_id,
        name=config.name,
        config=config,
        coordinator=coordinator,
        mode=resolver,
    )


async def async_unload_entry(hass: HomeAssistant, entry: BilresaConfigEntry) -> bool:
    """Unload the config entry and every subscription it owns."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await _async_shutdown(getattr(entry, "runtime_data", None))
    return unloaded


async def _async_shutdown(data: BilresaData | None) -> None:
    """Stop everything the entry started. Must never raise."""
    if data is None:
        return
    try:
        await data.dispatcher.async_shutdown()
    except Exception:  # noqa: BLE001 - teardown continues regardless
        _LOGGER.exception("Error while stopping the action dispatcher")
    for runtime in data.remotes.values():
        try:
            await runtime.coordinator.async_stop()
        except Exception:  # noqa: BLE001 - teardown continues regardless
            _LOGGER.exception("Error while stopping remote %s", runtime.ieee)
    data.remotes.clear()


async def async_remove_config_entry_device(
    hass: HomeAssistant, config_entry: BilresaConfigEntry, device_entry: DeviceEntry
) -> bool:
    """Allow deleting devices that no longer belong to a configured remote."""
    known = _known_device_ids(config_entry)
    return not any(
        identifier in known
        for domain, identifier in device_entry.identifiers
        if domain == DOMAIN
    )


# --------------------------------------------------------------------------- #
# Migration
# --------------------------------------------------------------------------- #


async def async_migrate_entry(hass: HomeAssistant, entry: BilresaConfigEntry) -> bool:
    """Migrate an old config entry to the current schema.

    The scaffold is deliberately explicit: every future step gets its own block
    that transforms the entry from one version to the next, so a user who skips
    releases still walks through all of them.
    """
    version = entry.version
    minor_version = entry.minor_version

    if version > CONFIG_ENTRY_VERSION:
        _LOGGER.error(
            "Config entry version %s.%s is newer than this integration supports "
            "(%s.%s); downgrade the integration or remove the entry",
            version,
            minor_version,
            CONFIG_ENTRY_VERSION,
            CONFIG_ENTRY_MINOR_VERSION,
        )
        return False

    if (version, minor_version) == (CONFIG_ENTRY_VERSION, CONFIG_ENTRY_MINOR_VERSION):
        return True

    data = dict(entry.data)
    options = dict(entry.options)

    # --- future entry migrations go here, one block per version ------------- #
    # if version == 1:
    #     data = _migrate_1_to_2(data)
    #     version, minor_version = 2, 1

    hass.config_entries.async_update_entry(
        entry,
        data=data,
        options=options,
        version=CONFIG_ENTRY_VERSION,
        minor_version=CONFIG_ENTRY_MINOR_VERSION,
    )

    for subentry in entry.subentries.values():
        migrated = _migrate_subentry(subentry)
        if migrated is not None:
            hass.config_entries.async_update_subentry(entry, subentry, data=migrated)

    _LOGGER.info(
        "Migrated config entry to version %s.%s",
        CONFIG_ENTRY_VERSION,
        CONFIG_ENTRY_MINOR_VERSION,
    )
    return True


def _migrate_subentry(subentry: ConfigSubentry) -> dict[str, Any] | None:
    """Return migrated subentry data, or None when nothing changed."""
    stored = subentry.data.get(CONF_SCHEMA_VERSION)
    if stored == SUBENTRY_SCHEMA_VERSION:
        return None

    data = dict(subentry.data)

    # --- future subentry migrations go here --------------------------------- #
    # if stored in (None, 1):
    #     data = _migrate_remote_1_to_2(data)

    data[CONF_SCHEMA_VERSION] = SUBENTRY_SCHEMA_VERSION
    return data


# --------------------------------------------------------------------------- #
# Update listener
# --------------------------------------------------------------------------- #


async def _async_update_listener(hass: HomeAssistant, entry: BilresaConfigEntry) -> None:
    """React to a changed config entry without reloading it if avoidable.

    Only structural changes -- a remote added or removed, or a different base
    topic -- justify a reload, because they change the set of entities and MQTT
    subscriptions. Everything else (action mappings, mode names, the remote's
    name, throttling, the modeless multiclick switch) is applied in place.
    """
    data: BilresaData | None = getattr(entry, "runtime_data", None)
    if data is None:
        return

    base_topic = _base_topic(entry)
    structure = _structure(entry, base_topic)

    if structure != data.structure:
        removed = {
            subentry_id
            for subentry_id in data.remotes
            if subentry_id not in entry.subentries
        }
        for subentry_id in removed:
            data.remotes[subentry_id].mode.async_remove()
        _LOGGER.debug("Structural change, reloading the config entry")
        hass.config_entries.async_schedule_reload(entry.entry_id)
        return

    for subentry in remote_subentries(entry):
        runtime = data.remotes.get(subentry.subentry_id)
        if runtime is None:
            continue
        try:
            config = RemoteConfig.from_subentry(subentry.data, base_topic=base_topic)
        except ValueError as err:
            _LOGGER.error("Ignoring broken update of remote %s: %s", runtime.name, err)
            continue
        runtime.config = config
        runtime.name = config.name
        runtime.coordinator.async_update_config(config)

    _async_register_devices(hass, entry)
    await data.dispatcher.async_handle_entry_update()


def _base_topic(entry: BilresaConfigEntry) -> str:
    """Return the Zigbee2MQTT base topic, options winning over data."""
    raw = entry.options.get(CONF_BASE_TOPIC) or entry.data.get(CONF_BASE_TOPIC)
    return str(raw or DEFAULT_BASE_TOPIC).strip().strip("/") or DEFAULT_BASE_TOPIC


def _structure(entry: BilresaConfigEntry, base_topic: str) -> tuple[Any, ...]:
    """Return the fingerprint of everything that needs a real reload.

    A renamed remote is explicitly *not* in here: the device registry entry is
    updated in place and the entities carry the device name, so a reload would
    only cost the user their MQTT subscriptions.
    """
    return (
        base_topic,
        tuple(
            sorted(
                (subentry.subentry_id, remote_ieee(subentry))
                for subentry in remote_subentries(entry)
            )
        ),
    )


# --------------------------------------------------------------------------- #
# Device registry
# --------------------------------------------------------------------------- #


def bridge_device_id(entry: BilresaConfigEntry) -> str:
    """Return the identifier of the service device all remotes hang off."""
    return f"bridge_{entry.entry_id}"


def _known_device_ids(entry: BilresaConfigEntry) -> set[str]:
    """Return every device identifier this entry currently owns."""
    return {remote_ieee(subentry) for subentry in remote_subentries(entry)} | {
        bridge_device_id(entry)
    }


@callback
def _async_register_devices(hass: HomeAssistant, entry: BilresaConfigEntry) -> None:
    """Create the bridge service device and one device per remote."""
    registry = dr.async_get(hass)
    bridge_identifier = (DOMAIN, bridge_device_id(entry))

    registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={bridge_identifier},
        manufacturer=MANUFACTURER,
        model="BILRESA Bridge",
        name="BILRESA Bridge",
        entry_type=DeviceEntryType.SERVICE,
    )

    for subentry in remote_subentries(entry):
        ieee = remote_ieee(subentry)
        registry.async_get_or_create(
            config_entry_id=entry.entry_id,
            config_subentry_id=subentry.subentry_id,
            identifiers={(DOMAIN, ieee)},
            manufacturer=MANUFACTURER,
            model=MODEL_WHEEL_NAME,
            model_id=MODEL_WHEEL,
            name=remote_name(subentry),
            serial_number=ieee,
            via_device=bridge_identifier,
        )


@callback
def _async_cleanup_devices(hass: HomeAssistant, entry: BilresaConfigEntry) -> None:
    """Drop registry devices of remotes that no longer exist."""
    registry = dr.async_get(hass)
    known = _known_device_ids(entry)

    for device in dr.async_entries_for_config_entry(registry, entry.entry_id):
        identifiers = {
            identifier for domain, identifier in device.identifiers if domain == DOMAIN
        }
        if not identifiers or identifiers & known:
            continue
        _LOGGER.debug("Removing stale device %s", device.name or device.id)
        try:
            registry.async_update_device(
                device.id, remove_config_entry_id=entry.entry_id
            )
        except Exception:  # noqa: BLE001 - a stale device must not break setup
            _LOGGER.exception("Could not remove stale device %s", device.id)


# --------------------------------------------------------------------------- #
# Services
# --------------------------------------------------------------------------- #

_SET_MODE_SCHEMA: Final = vol.Schema(
    {
        **cv.TARGET_SERVICE_FIELDS,
        vol.Required(ATTR_MODE): vol.Any(vol.Coerce(int), cv.string),
    }
)

_NEXT_MODE_SCHEMA: Final = vol.Schema(
    {
        **cv.TARGET_SERVICE_FIELDS,
        vol.Optional(ATTR_STEP, default=1): vol.All(vol.Coerce(int), vol.Range(-9, 9)),
    }
)


@callback
def _async_register_services(hass: HomeAssistant) -> None:
    """Register the integration services exactly once."""
    if hass.data.get(_SERVICES_REGISTERED):
        return
    hass.data[_SERVICES_REGISTERED] = True

    hass.services.async_register(
        DOMAIN, SERVICE_SET_MODE, _async_service_set_mode, schema=_SET_MODE_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_NEXT_MODE, _async_service_next_mode, schema=_NEXT_MODE_SCHEMA
    )


async def _async_service_set_mode(call: ServiceCall) -> None:
    """Switch the targeted remotes to a specific mode."""
    data = _async_runtime(call.hass)
    requested = call.data[ATTR_MODE]
    for runtime in await _async_targets(call.hass, data, call):
        runtime.mode.async_set_mode(_resolve_mode(runtime, requested))


async def _async_service_next_mode(call: ServiceCall) -> None:
    """Advance the targeted remotes by one mode (or by ``step``)."""
    data = _async_runtime(call.hass)
    step = call.data.get(ATTR_STEP, 1)
    for runtime in await _async_targets(call.hass, data, call):
        runtime.mode.async_cycle(step)


@callback
def _async_runtime(hass: HomeAssistant) -> BilresaData:
    """Return the runtime data of the loaded config entry."""
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is not ConfigEntryState.LOADED:
            continue
        data = getattr(entry, "runtime_data", None)
        if isinstance(data, BilresaData):
            return data
    raise ServiceValidationError("The BILRESA Remote integration is not loaded")


def _resolve_mode(runtime: RemoteRuntime, requested: Any) -> int:
    """Return a 1-based mode index from a number or a mode name."""
    names = runtime.mode.mode_names
    count = runtime.mode.mode_count

    if isinstance(requested, int) and not isinstance(requested, bool):
        mode = requested
    else:
        text = str(requested).strip()
        folded = text.casefold()
        for index, name in enumerate(names, start=1):
            if name.casefold() == folded:
                return index
        try:
            mode = int(text, 10)
        except ValueError:
            raise ServiceValidationError(
                f"{runtime.name} has no mode named {text!r}; available: "
                + ", ".join(names)
            ) from None

    if not 1 <= mode <= count:
        raise ServiceValidationError(
            f"Mode {mode} is out of range for {runtime.name} (1..{count})"
        )
    return mode


async def _async_targets(
    hass: HomeAssistant, data: BilresaData, call: ServiceCall
) -> list[RemoteRuntime]:
    """Resolve the service target to the remotes it addresses.

    Areas, floors, labels, devices and entities all end up here; the bridge
    service device is treated as "every remote", which is what a user selecting
    it expects.
    """
    device_ids: set[str] = set(_as_list(call.data.get(ATTR_DEVICE_ID)))
    entity_registry = er.async_get(hass)

    selected = service_helper.async_extract_referenced_entity_ids(hass, call)
    if isawaitable(selected):
        # Defensive: the helper was a coroutine in older cores.
        selected = await selected
    entity_ids: set[str] = set(selected.referenced) | set(selected.indirectly_referenced)

    for entity_id in entity_ids:
        entity = entity_registry.async_get(entity_id)
        if entity is not None and entity.device_id:
            device_ids.add(entity.device_id)

    if not device_ids:
        raise ServiceValidationError(
            "No target given. Select a BILRESA remote device, one of its "
            "entities, or an area containing one."
        )

    device_registry = dr.async_get(hass)
    bridge_id = bridge_device_id(data.entry)
    matched: dict[str, RemoteRuntime] = {}

    for device_id in device_ids:
        device = device_registry.async_get(device_id)
        if device is None:
            continue
        for domain, identifier in device.identifiers:
            if domain != DOMAIN:
                continue
            if identifier == bridge_id:
                matched.update(
                    {runtime.subentry_id: runtime for runtime in data.remotes.values()}
                )
                continue
            runtime = data.resolve(identifier)
            if runtime is not None:
                matched[runtime.subentry_id] = runtime

    if not matched:
        raise ServiceValidationError("The target does not contain a BILRESA remote")
    return list(matched.values())


def _as_list(value: Any) -> Iterable[str]:
    """Return a service target field as a list of strings."""
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, Iterable):
        return [str(item) for item in value]
    return (str(value),)
