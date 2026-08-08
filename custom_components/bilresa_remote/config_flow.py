"""Configuration flows for the IKEA BILRESA Remote integration.

Everything the user configures lives in the config entry:

* the config entry itself carries the global settings (the Zigbee2MQTT base
  topic), guarded by ``single_config_entry``;
* one ``remote`` subentry per physical remote carries its appearance, its mode
  setup and the action sequences bound to every mode.

All user visible text lives in ``translations/en.json`` and
``translations/de.json``. This module only supplies markdown placeholders
(illustrations, names, counters) so the wording stays translatable.
"""

from __future__ import annotations

import copy
import logging
import re
from collections.abc import Iterable, Mapping
from typing import Any, Final

import voluptuous as vol
from homeassistant.config_entries import (
    SOURCE_RECONFIGURE,
    ConfigEntry,
    ConfigEntryState,
    ConfigFlow,
    ConfigFlowResult,
    ConfigSubentry,
    ConfigSubentryFlow,
    OptionsFlow,
    SubentryFlowResult,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import section
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import selector

from .const import (
    ACTION_CLICK,
    ACTION_CLICK_OFF,
    ACTION_CLICK_ON,
    ACTION_DOUBLE,
    ACTION_TRIPLE,
    ACTION_WHEEL,
    COLORS,
    CONF_BASE_TOPIC,
    CONF_COLOR,
    CONF_GROUP_IDS,
    CONF_IEEE,
    CONF_MAPPINGS,
    CONF_MODE_COUNT,
    CONF_MODE_CYCLE_ACTION,
    CONF_MODE_NAMES,
    CONF_MODE_SOURCE,
    CONF_MODELESS_MULTICLICK,
    CONF_NAME,
    CONF_SCRIPT_MODE,
    CONF_SEQUENCE,
    CONF_SPLIT_SINGLE_CLICK,
    CONF_WHEEL_THROTTLE_MS,
    DEFAULT_BASE_TOPIC,
    DEFAULT_COLOR,
    DEFAULT_GROUP_IDS,
    DEFAULT_MODE_COUNT,
    DEFAULT_MODE_SOURCE,
    DEFAULT_MODELESS_MULTICLICK,
    DEFAULT_SPLIT_SINGLE_CLICK,
    DEFAULT_WHEEL_THROTTLE_MS,
    DOMAIN,
    IMAGE_PATH,
    MODE_SOURCE_DEVICE,
    MODE_SOURCES,
    SUBENTRY_TYPE_REMOTE,
    SUPPORTED_MODELS,
)
from .z2m import async_fetch_devices

_LOGGER = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Local contract additions (not present in const.py -- see module report)
# --------------------------------------------------------------------------- #

#: Mode key under which mode independent double/triple click bindings are
#: stored. Mirrors ``dispatcher.MODELESS_MODE_KEY``; kept local so the flow
#: never imports the runtime modules.
MODELESS_MODE_KEY: Final = "*"

#: Subentry key for "wrap around after the last mode". Mirrors
#: ``mode.CONF_MODE_CYCLE_WRAP``.
CONF_MODE_CYCLE_WRAP: Final = "cycle_wrap"

#: Version of the subentry payload layout, written on every save.
CONF_SCHEMA_VERSION: Final = "schema_version"
SCHEMA_VERSION: Final = 1

#: Flow-only field: "my remote is not in the list".
CONF_MANUAL_ENTRY: Final = "manual_entry"
#: Flow-only field: the name of the mode edited in the current step.
CONF_MODE_NAME: Final = "mode_name"

SECTION_ADVANCED: Final = "advanced"
SECTION_WHEEL: Final = "wheel_options"

MQTT_DOMAIN: Final = "mqtt"
DOCS_URL: Final = "https://github.com/DieserMerlin/BILRESA-Zigbee-HA"

#: The retained ``bridge/devices`` topic answers instantly when MQTT is healthy.
DISCOVERY_TIMEOUT: Final = 5.0

#: ``internal`` mode switching needs an action to consume; only the discrete
#: click kinds make sense, the wheel does not.
CYCLE_ACTIONS: Final = (ACTION_TRIPLE, ACTION_DOUBLE, ACTION_CLICK)

SCRIPT_MODES: Final = ("restart", "single", "queued", "parallel")
DEFAULT_SCRIPT_MODE: Final = "restart"

MAX_MODE_COUNT: Final = 9
MAX_WHEEL_THROTTLE_MS: Final = 5000

#: MQTT wildcards and whitespace would break the device topic.
_BAD_TOPIC = re.compile(r"[#+\s]")

_COLOR_HINTS: Final = {
    "red": ("red", "rot", "rust", "terracotta"),
    "beige": ("beige", "white", "weiss", "weiß", "sand"),
    "green": ("green", "grün", "gruen", "teal", "turquoise"),
}


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _clean_topic(value: Any) -> str:
    """Return a normalised MQTT base topic."""
    return str(value or "").strip().strip("/")


def _valid_topic(value: str) -> bool:
    """Return True if the string can be used as a Zigbee2MQTT base topic."""
    return bool(value) and not _BAD_TOPIC.search(value)


def _as_int(value: Any, default: int) -> int:
    """Best-effort int conversion that never raises."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip(), 0)
        except ValueError:
            return default
    return default


def _entry_base_topic(entry: ConfigEntry) -> str:
    """Return the base topic of the config entry, options winning over data."""
    value = entry.options.get(CONF_BASE_TOPIC) or entry.data.get(CONF_BASE_TOPIC)
    return _clean_topic(value) or DEFAULT_BASE_TOPIC


def _image_tag(color: str, width: int) -> str:
    """Return an HTML image tag for one of the shipped illustrations.

    The SVGs only carry a ``viewBox``, so without an explicit width a browser
    would render them at the 300px CSS default -- far too large for a dialog.
    """
    name = color if color in COLORS else DEFAULT_COLOR
    return f'<img src="{IMAGE_PATH}/bilresa-{name}.svg" width="{width}">'


def _placeholders(color: str | None = None, **extra: str) -> dict[str, str]:
    """Return the markdown placeholders shared by every step.

    Every step is given the full set so a translated text can use any of them
    without risking a missing-placeholder warning in the frontend.
    """
    placeholders = {
        "image": _image_tag(color or DEFAULT_COLOR, 150),
        "image_small": _image_tag(color or DEFAULT_COLOR, 96),
        "image_red": _image_tag("red", 110),
        "image_beige": _image_tag("beige", 110),
        "image_green": _image_tag("green", 110),
        "image_row": " ".join(_image_tag(item, 104) for item in COLORS),
        "docs_url": DOCS_URL,
        "group_ids": ", ".join(str(item) for item in DEFAULT_GROUP_IDS),
    }
    placeholders.update(extra)
    return placeholders


async def _async_ensure_images(hass: HomeAssistant) -> None:
    """Make sure the illustrations are actually served before a step shows them.

    Every step renders ``<img src="{IMAGE_PATH}/...">``. On a fresh install no
    config entry exists yet, so ``async_setup_entry`` -- and with it the static
    path registration -- has not run when the very first flow starts and every
    image would 404. The registration is idempotent, so calling it here is free
    on every later run.

    Imported lazily: ``__init__`` imports the runtime modules, and the config
    flow must stay loadable without them.
    """
    try:
        from . import async_register_images

        await async_register_images(hass)
    except Exception:
        _LOGGER.debug("Could not register the illustration path", exc_info=True)


def _guess_color(*texts: str) -> str:
    """Guess the housing colour from the Zigbee2MQTT name or description."""
    haystack = " ".join(texts).casefold()
    for color, hints in _COLOR_HINTS.items():
        if any(hint in haystack for hint in hints):
            return color
    return DEFAULT_COLOR


def _parse_group_ids(value: Any) -> list[int]:
    """Parse a comma separated list of Zigbee group ids.

    Raises:
        ValueError: if an item is not a group id in range.
    """
    if isinstance(value, (list, tuple)):
        items: Iterable[Any] = value
    else:
        items = str(value or "").replace(";", ",").split(",")
    result: list[int] = []
    for item in items:
        text = str(item).strip()
        if not text:
            continue
        number = int(text, 0)
        if not 0 <= number <= 0xFFFF:
            raise ValueError(f"group id out of range: {number}")
        result.append(number)
    if not result:
        raise ValueError("no group ids given")
    return result


def _validate_sequence(value: Any) -> list[Any]:
    """Return a storable action sequence.

    The action selector is a pure pass-through, so the flow validates the
    structure itself -- a broken sequence stored here would otherwise only
    surface as a repair issue much later. The *original* value is returned:
    ``cv.SCRIPT_SCHEMA`` turns templates into ``Template`` objects, which are
    not JSON serialisable and must never reach the config entry.

    Raises:
        vol.Invalid: if the sequence is not a valid list of actions.
    """
    if value is None or value == "":
        return []
    if isinstance(value, Mapping):
        value = [dict(value)]
    if not isinstance(value, (list, tuple)):
        raise vol.Invalid("expected a list of actions")
    sequence = list(value)
    if not sequence:
        return []
    try:
        cv.SCRIPT_SCHEMA(copy.deepcopy(sequence))
    except vol.Invalid:
        raise
    except Exception as err:
        raise vol.Invalid(str(err)) from err
    return sequence


#: Lazily built and cached; the selector object itself is stateless.
_SEQUENCE_SELECTOR: Any = None


def _sequence_selector() -> Any:
    """Return the selector used to edit an action sequence.

    The visual action editor is the whole point of the UI, but it is not
    guaranteed to be available in every context. When the ``action`` selector
    cannot be built the flow degrades to a raw YAML object editor, which stores
    exactly the same data.
    """
    global _SEQUENCE_SELECTOR

    if _SEQUENCE_SELECTOR is None:
        try:
            _SEQUENCE_SELECTOR = selector.selector({"action": {}})
        except (vol.Invalid, KeyError, TypeError, ValueError):
            _LOGGER.warning(
                "The action selector is unavailable, falling back to a raw YAML "
                "editor for action sequences"
            )
            _SEQUENCE_SELECTOR = selector.selector({"object": {}})
    return _SEQUENCE_SELECTOR


def _text_selector(multiline: bool = False) -> Any:
    """Return a plain text selector."""
    return selector.selector({"text": {"multiline": multiline}})


def _bool_selector() -> Any:
    """Return a toggle selector."""
    return selector.selector({"boolean": {}})


def _select_selector(options: Iterable[str], translation_key: str) -> Any:
    """Return a dropdown whose labels come from the ``selector`` translations."""
    return selector.selector(
        {
            "select": {
                "options": list(options),
                "mode": "dropdown",
                "translation_key": translation_key,
            }
        }
    )


def _number_selector(minimum: int, maximum: int, step: int = 1, unit: str | None = None) -> Any:
    """Return a numeric box selector."""
    config: dict[str, Any] = {"min": minimum, "max": maximum, "step": step, "mode": "box"}
    if unit:
        config["unit_of_measurement"] = unit
    return selector.selector({"number": config})


def _device_selector(devices: list[dict[str, str]]) -> Any:
    """Return a dropdown listing the remotes Zigbee2MQTT knows about."""
    options = [{"value": device["ieee"], "label": device["label"]} for device in devices]
    return selector.selector({"select": {"options": options, "mode": "dropdown"}})


def _normalise_device(raw: Any) -> dict[str, str] | None:
    """Normalise one ``bridge/devices`` entry.

    Tolerates both the flat shape documented for :func:`async_fetch_devices`
    and the raw Zigbee2MQTT shape with a nested ``definition`` block.
    """
    if not isinstance(raw, Mapping):
        return None
    ieee = str(raw.get(CONF_IEEE) or raw.get("ieee_address") or "").strip()
    if not ieee:
        return None
    definition = raw.get("definition")
    if not isinstance(definition, Mapping):
        definition = {}
    model = str(raw.get("model") or definition.get("model") or "").strip()
    # The free-text device comment in Zigbee2MQTT is where people note which
    # physical unit this is ("Red", "Kitchen", ...). It takes precedence over the
    # generic model description, both for the picker label and for guessing the
    # housing colour.
    comment = str(raw.get("description") or "").strip()
    description = comment or str(definition.get("description") or "").strip()
    friendly_name = str(raw.get("friendly_name") or ieee).strip() or ieee

    # Zigbee2MQTT leaves friendly_name equal to the IEEE address unless the
    # device was renamed. Without the comment, three identical remotes would show
    # up as three indistinguishable hex strings.
    parts: list[str] = []
    if comment:
        parts.append(comment)
    if friendly_name != ieee:
        parts.append(friendly_name)
    parts.append(ieee)
    label = " - ".join(parts)
    if model:
        label = f"{label} ({model})"
    return {
        "ieee": ieee,
        "friendly_name": friendly_name,
        "model": model,
        "description": description,
        "label": label,
    }


def _is_supported(device: Mapping[str, str]) -> bool:
    """Return True if the device looks like a supported BILRESA remote."""
    model = device.get("model", "").upper()
    if model in {item.upper() for item in SUPPORTED_MODELS}:
        return True
    haystack = f"{device.get('model', '')} {device.get('description', '')}".casefold()
    return "bilresa" in haystack


async def _async_mqtt_state(hass: HomeAssistant) -> str:
    """Return ``ok``, ``missing`` (no MQTT integration) or ``unavailable``."""
    entries = hass.config_entries.async_entries(MQTT_DOMAIN)
    if not entries:
        return "missing"
    if not any(entry.state is ConfigEntryState.LOADED for entry in entries):
        return "unavailable"
    try:
        from homeassistant.components import mqtt
    except ImportError:  # pragma: no cover - mqtt is a manifest dependency
        return "missing"
    waiter = getattr(mqtt, "async_wait_for_mqtt_client", None)
    if waiter is None:  # pragma: no cover - defensive, API is stable
        return "ok"
    return "ok" if await waiter(hass) else "unavailable"


async def _async_fetch_remotes(hass: HomeAssistant, base_topic: str) -> list[dict[str, str]]:
    """Return the BILRESA remotes Zigbee2MQTT currently exposes."""
    try:
        payload = await async_fetch_devices(hass, base_topic, timeout=DISCOVERY_TIMEOUT)
    except Exception:
        _LOGGER.debug("Could not read %s/bridge/devices", base_topic, exc_info=True)
        return []
    devices = [
        device
        for device in (_normalise_device(item) for item in payload or ())
        if device is not None
    ]
    supported = [device for device in devices if _is_supported(device)]
    supported.sort(key=lambda device: device["friendly_name"].casefold())
    return supported


# --------------------------------------------------------------------------- #
# Main config flow
# --------------------------------------------------------------------------- #


class BilresaConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the one-time setup of the integration."""

    VERSION = 1
    MINOR_VERSION = 1

    def __init__(self) -> None:
        """Initialise the flow."""
        self._base_topic = DEFAULT_BASE_TOPIC

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> BilresaOptionsFlow:
        """Return the options flow for global settings."""
        return BilresaOptionsFlow()

    @classmethod
    @callback
    def async_get_supported_subentry_types(
        cls, config_entry: ConfigEntry
    ) -> dict[str, type[ConfigSubentryFlow]]:
        """Return the subentry flows offered on the integration page."""
        return {SUBENTRY_TYPE_REMOTE: RemoteSubentryFlow}

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Greet the user, check MQTT and ask for the Zigbee2MQTT base topic."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        await _async_ensure_images(self.hass)

        mqtt_state = await _async_mqtt_state(self.hass)
        if mqtt_state != "ok":
            return self.async_abort(
                reason="mqtt_missing" if mqtt_state == "missing" else "mqtt_unavailable",
                description_placeholders=_placeholders(),
            )

        errors: dict[str, str] = {}
        if user_input is not None:
            topic = _clean_topic(user_input.get(CONF_BASE_TOPIC))
            if not _valid_topic(topic):
                errors[CONF_BASE_TOPIC] = "invalid_base_topic"
            else:
                self._base_topic = topic
                return await self.async_step_tutorial()

        suggested = _clean_topic(
            user_input.get(CONF_BASE_TOPIC) if user_input else self._base_topic
        )
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_BASE_TOPIC,
                    default=DEFAULT_BASE_TOPIC,
                    description={"suggested_value": suggested or DEFAULT_BASE_TOPIC},
                ): _text_selector(),
            }
        )
        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=errors,
            description_placeholders=_placeholders(),
        )

    async def async_step_tutorial(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Show the pairing and Touchlink guide; purely informational."""
        if user_input is not None:
            return self.async_create_entry(
                title="IKEA BILRESA Remote",
                data={CONF_BASE_TOPIC: self._base_topic},
            )
        return self.async_show_form(
            step_id="tutorial",
            data_schema=vol.Schema({}),
            description_placeholders=_placeholders("red"),
            last_step=True,
        )


# --------------------------------------------------------------------------- #
# Options flow
# --------------------------------------------------------------------------- #


class BilresaOptionsFlow(OptionsFlow):
    """Global settings plus a way back into the tutorial."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Offer the global settings and the tutorial."""
        await _async_ensure_images(self.hass)
        return self.async_show_menu(
            step_id="init",
            menu_options=["settings", "tutorial"],
            description_placeholders=_placeholders(),
        )

    async def async_step_settings(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Edit the global settings."""
        entry = self.config_entry
        errors: dict[str, str] = {}

        if user_input is not None:
            topic = _clean_topic(user_input.get(CONF_BASE_TOPIC))
            if not _valid_topic(topic):
                errors[CONF_BASE_TOPIC] = "invalid_base_topic"
            else:
                # The base topic is written to both places: setup code reading
                # entry.data keeps working, and options stay the single source
                # of truth for everything the options flow owns.
                if topic != _clean_topic(entry.data.get(CONF_BASE_TOPIC)):
                    self.hass.config_entries.async_update_entry(
                        entry, data={**entry.data, CONF_BASE_TOPIC: topic}
                    )
                return self.async_create_entry(data={**entry.options, CONF_BASE_TOPIC: topic})

        current = _entry_base_topic(entry)
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_BASE_TOPIC,
                    default=DEFAULT_BASE_TOPIC,
                    description={"suggested_value": current},
                ): _text_selector(),
            }
        )
        return self.async_show_form(
            step_id="settings",
            data_schema=schema,
            errors=errors,
            description_placeholders=_placeholders(),
        )

    async def async_step_tutorial(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Show the pairing and Touchlink guide again."""
        if user_input is not None:
            return await self.async_step_init()
        return self.async_show_form(
            step_id="tutorial",
            data_schema=vol.Schema({}),
            description_placeholders=_placeholders("red"),
        )


# --------------------------------------------------------------------------- #
# Remote subentry flow
# --------------------------------------------------------------------------- #


class RemoteSubentryFlow(ConfigSubentryFlow):
    """Add or reconfigure a single remote.

    Config flows cannot render a matrix, so the action assignment is paginated:
    one step per mode with a handful of action selectors. Reconfiguration puts a
    menu in front of the same steps, which turns "change one cell" into two
    clicks instead of a walk through the whole wizard.
    """

    def __init__(self) -> None:
        """Initialise the flow state."""
        self._data: dict[str, Any] = {}
        self._mappings: dict[str, dict[str, Any]] = {}
        self._mode_names: list[str] = []
        self._devices: list[dict[str, str]] = []
        self._mode_index = 1

    # -- shared state ------------------------------------------------------ #

    @property
    def _mode_count(self) -> int:
        """Return the configured number of modes."""
        count = _as_int(self._data.get(CONF_MODE_COUNT), DEFAULT_MODE_COUNT)
        return max(1, min(count, MAX_MODE_COUNT))

    @property
    def _modeless(self) -> bool:
        """Return True if double/triple click are bound once per remote."""
        return bool(self._data.get(CONF_MODELESS_MULTICLICK, DEFAULT_MODELESS_MULTICLICK))

    @property
    def _split_click(self) -> bool:
        """Return True if the alternating single click is bound separately."""
        return bool(self._data.get(CONF_SPLIT_SINGLE_CLICK, DEFAULT_SPLIT_SINGLE_CLICK))

    @property
    def _remote_name(self) -> str:
        """Return the display name of the remote being edited."""
        return str(self._data.get(CONF_NAME) or self._data.get(CONF_IEEE) or "")

    @property
    def _color(self) -> str:
        """Return the housing colour of the remote being edited."""
        color = self._data.get(CONF_COLOR)
        return color if color in COLORS else DEFAULT_COLOR

    def _mode_name(self, index: int) -> str:
        """Return the stored name of a 1-based mode, or a generic default."""
        if 1 <= index <= len(self._mode_names):
            name = str(self._mode_names[index - 1]).strip()
            if name:
                return name
        return f"Mode {index}"

    def _set_mode_name(self, index: int, name: str) -> None:
        """Store the name of a 1-based mode."""
        while len(self._mode_names) < index:
            self._mode_names.append(f"Mode {len(self._mode_names) + 1}")
        self._mode_names[index - 1] = name

    def _binding(self, mode_key: str, action: str) -> Any:
        """Return the stored sequence of one binding, or None."""
        raw = self._mappings.get(mode_key, {}).get(action)
        if isinstance(raw, Mapping):
            raw = raw.get(CONF_SEQUENCE)
        if isinstance(raw, (list, tuple)) and raw:
            return list(raw)
        return None

    def _binding_option(self, mode_key: str, action: str, key: str, default: Any) -> Any:
        """Return one stored option of a binding."""
        raw = self._mappings.get(mode_key, {}).get(action)
        if isinstance(raw, Mapping) and raw.get(key) is not None:
            return raw[key]
        return default

    def _store_binding(
        self, mode_key: str, action: str, sequence: list[Any], **options: Any
    ) -> None:
        """Store or drop one binding, keeping unrelated bindings untouched."""
        bindings = self._mappings.setdefault(mode_key, {})
        if not sequence:
            bindings.pop(action, None)
            if not bindings:
                self._mappings.pop(mode_key, None)
            return
        binding: dict[str, Any] = {CONF_SEQUENCE: sequence}
        binding.update({key: value for key, value in options.items() if value is not None})
        bindings[action] = binding

    def _known_ieees(self) -> set[str]:
        """Return the IEEE addresses already configured, excluding this one."""
        entry = self._get_entry()
        current = None
        if self.source == SOURCE_RECONFIGURE:
            current = self._get_reconfigure_subentry().subentry_id
        return {
            str(subentry.data.get(CONF_IEEE))
            for subentry_id, subentry in entry.subentries.items()
            if subentry.subentry_type == SUBENTRY_TYPE_REMOTE and subentry_id != current
        }

    def _placeholders(self, **extra: str) -> dict[str, str]:
        """Return the placeholders of a remote related step."""
        return _placeholders(
            self._color,
            remote_name=self._remote_name,
            mode_index=str(self._mode_index),
            mode_count=str(self._mode_count),
            mode_name=self._mode_name(self._mode_index),
            **extra,
        )

    # -- device selection -------------------------------------------------- #

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> SubentryFlowResult:
        """Pick the remote from the Zigbee2MQTT device list."""
        errors: dict[str, str] = {}
        await _async_ensure_images(self.hass)

        if not self._devices:
            base_topic = _entry_base_topic(self._get_entry())
            self._devices = await _async_fetch_remotes(self.hass, base_topic)

        # Remotes that already have a subentry would only produce an
        # "already configured" error, so keep them out of the picker entirely.
        known = self._known_ieees()
        available = [device for device in self._devices if device["ieee"] not in known]
        if not available:
            return await self.async_step_manual()

        if user_input is not None:
            if user_input.get(CONF_MANUAL_ENTRY):
                return await self.async_step_manual()
            ieee = str(user_input.get(CONF_IEEE) or "").strip()
            if not ieee:
                errors[CONF_IEEE] = "no_device_selected"
            elif ieee in self._known_ieees():
                errors[CONF_IEEE] = "already_configured"
            else:
                device = next((item for item in available if item["ieee"] == ieee), None)
                self._data[CONF_IEEE] = ieee
                if device is not None:
                    self._data.setdefault(CONF_NAME, device["friendly_name"])
                    self._data.setdefault(
                        CONF_COLOR,
                        _guess_color(device["friendly_name"], device["description"]),
                    )
                return await self.async_step_options()

        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_IEEE,
                    description={"suggested_value": self._data.get(CONF_IEEE)},
                ): _device_selector(available),
                vol.Required(CONF_MANUAL_ENTRY, default=False): _bool_selector(),
            }
        )
        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=errors,
            description_placeholders=self._placeholders(device_count=str(len(available))),
        )

    async def async_step_manual(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Enter the IEEE address (or friendly name) by hand."""
        errors: dict[str, str] = {}

        if user_input is not None:
            ieee = str(user_input.get(CONF_IEEE) or "").strip()
            if not ieee or _BAD_TOPIC.search(ieee) or "/" in ieee:
                errors[CONF_IEEE] = "invalid_ieee"
            elif ieee in self._known_ieees():
                errors[CONF_IEEE] = "already_configured"
            else:
                self._data[CONF_IEEE] = ieee
                self._data.setdefault(CONF_NAME, ieee)
                return await self.async_step_options()

        schema = vol.Schema(
            {
                vol.Required(
                    CONF_IEEE,
                    description={"suggested_value": self._data.get(CONF_IEEE)},
                ): _text_selector(),
            }
        )
        return self.async_show_form(
            step_id="manual",
            data_schema=schema,
            errors=errors,
            description_placeholders=self._placeholders(device_count=str(len(self._devices))),
        )

    # -- appearance and behaviour ------------------------------------------ #

    async def async_step_options(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Name, colour and mode behaviour of the remote."""
        errors: dict[str, str] = {}

        if user_input is not None:
            advanced: Mapping[str, Any] = user_input.get(SECTION_ADVANCED) or {}
            stored = self._data
            group_ids = list(stored.get(CONF_GROUP_IDS) or DEFAULT_GROUP_IDS)
            if CONF_GROUP_IDS in advanced:
                try:
                    group_ids = _parse_group_ids(advanced[CONF_GROUP_IDS])
                except ValueError:
                    # The field lives inside a collapsed section, where the
                    # frontend cannot anchor an inline error -- show it on the
                    # form instead.
                    errors["base"] = "invalid_group_ids"
            name = str(user_input.get(CONF_NAME) or "").strip()
            if not name:
                errors[CONF_NAME] = "name_required"

            if not errors:
                self._data.update(
                    {
                        CONF_NAME: name,
                        CONF_COLOR: user_input.get(CONF_COLOR, self._color),
                        CONF_MODE_SOURCE: user_input.get(
                            CONF_MODE_SOURCE,
                            stored.get(CONF_MODE_SOURCE, DEFAULT_MODE_SOURCE),
                        ),
                        CONF_MODE_COUNT: max(
                            1,
                            min(
                                _as_int(user_input.get(CONF_MODE_COUNT), self._mode_count),
                                MAX_MODE_COUNT,
                            ),
                        ),
                        CONF_MODELESS_MULTICLICK: bool(
                            user_input.get(CONF_MODELESS_MULTICLICK, self._modeless)
                        ),
                        CONF_MODE_CYCLE_ACTION: user_input.get(
                            CONF_MODE_CYCLE_ACTION,
                            stored.get(CONF_MODE_CYCLE_ACTION, ACTION_TRIPLE),
                        ),
                        CONF_SPLIT_SINGLE_CLICK: bool(
                            advanced.get(CONF_SPLIT_SINGLE_CLICK, self._split_click)
                        ),
                        CONF_MODE_CYCLE_WRAP: bool(
                            advanced.get(
                                CONF_MODE_CYCLE_WRAP,
                                stored.get(CONF_MODE_CYCLE_WRAP, True),
                            )
                        ),
                        CONF_WHEEL_THROTTLE_MS: max(
                            0,
                            min(
                                _as_int(
                                    advanced.get(
                                        CONF_WHEEL_THROTTLE_MS,
                                        stored.get(CONF_WHEEL_THROTTLE_MS),
                                    ),
                                    DEFAULT_WHEEL_THROTTLE_MS,
                                ),
                                MAX_WHEEL_THROTTLE_MS,
                            ),
                        ),
                        CONF_GROUP_IDS: group_ids,
                    }
                )
                del self._mode_names[self._mode_count :]
                if self.source == SOURCE_RECONFIGURE:
                    return self._async_save_and_return()
                self._mode_index = 1
                return await self.async_step_mode_actions()

        advanced_defaults: Mapping[str, Any] = (
            user_input.get(SECTION_ADVANCED) or {} if user_input else {}
        )

        def current(key: str, fallback: Any) -> Any:
            """Keep what the user typed when the form comes back with errors."""
            if user_input is not None and key in user_input:
                return user_input[key]
            return fallback

        def current_advanced(key: str, fallback: Any) -> Any:
            """Return the stored value for a field inside the advanced section."""
            return advanced_defaults.get(key, fallback)

        effective_mode_source = str(
            current(CONF_MODE_SOURCE, self._data.get(CONF_MODE_SOURCE, DEFAULT_MODE_SOURCE))
        )

        stored_groups = ", ".join(
            str(item) for item in self._data.get(CONF_GROUP_IDS, DEFAULT_GROUP_IDS)
        )
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_NAME,
                    description={
                        "suggested_value": current(CONF_NAME, self._data.get(CONF_NAME, ""))
                    },
                ): _text_selector(),
                vol.Required(
                    CONF_COLOR, default=str(current(CONF_COLOR, self._color))
                ): _select_selector(COLORS, "color"),
                vol.Required(
                    CONF_MODE_SOURCE,
                    default=str(
                        current(
                            CONF_MODE_SOURCE,
                            self._data.get(CONF_MODE_SOURCE, DEFAULT_MODE_SOURCE),
                        )
                    ),
                ): _select_selector(MODE_SOURCES, "mode_source"),
                vol.Required(
                    CONF_MODE_COUNT,
                    default=_as_int(current(CONF_MODE_COUNT, self._mode_count), DEFAULT_MODE_COUNT),
                ): _number_selector(1, MAX_MODE_COUNT),
                vol.Required(
                    CONF_MODELESS_MULTICLICK,
                    default=bool(current(CONF_MODELESS_MULTICLICK, self._modeless)),
                ): _bool_selector(),
                vol.Required(SECTION_ADVANCED): section(
                    vol.Schema(
                        {
                            # Only meaningful when the integration has to advance
                            # the mode itself. With the device mode source the
                            # remote's lower button switches channels in hardware
                            # and this setting would do nothing, so it is hidden.
                            **(
                                {
                                    vol.Required(
                                        CONF_MODE_CYCLE_ACTION,
                                        default=str(
                                            current_advanced(
                                                CONF_MODE_CYCLE_ACTION,
                                                self._data.get(
                                                    CONF_MODE_CYCLE_ACTION, ACTION_TRIPLE
                                                ),
                                            )
                                        ),
                                    ): _select_selector(CYCLE_ACTIONS, "cycle_action")
                                }
                                if effective_mode_source != MODE_SOURCE_DEVICE
                                else {}
                            ),
                            vol.Required(
                                CONF_SPLIT_SINGLE_CLICK,
                                default=bool(
                                    current_advanced(CONF_SPLIT_SINGLE_CLICK, self._split_click)
                                ),
                            ): _bool_selector(),
                            vol.Required(
                                CONF_MODE_CYCLE_WRAP,
                                default=bool(
                                    current_advanced(
                                        CONF_MODE_CYCLE_WRAP,
                                        self._data.get(CONF_MODE_CYCLE_WRAP, True),
                                    )
                                ),
                            ): _bool_selector(),
                            vol.Required(
                                CONF_WHEEL_THROTTLE_MS,
                                default=_as_int(
                                    current_advanced(
                                        CONF_WHEEL_THROTTLE_MS,
                                        self._data.get(CONF_WHEEL_THROTTLE_MS),
                                    ),
                                    DEFAULT_WHEEL_THROTTLE_MS,
                                ),
                            ): _number_selector(0, MAX_WHEEL_THROTTLE_MS, 10, "ms"),
                            vol.Required(
                                CONF_GROUP_IDS,
                                default=str(current_advanced(CONF_GROUP_IDS, stored_groups)),
                            ): _text_selector(),
                        }
                    ),
                    {"collapsed": True},
                ),
            }
        )
        return self.async_show_form(
            step_id="options",
            data_schema=schema,
            errors=errors,
            description_placeholders=self._placeholders(),
        )

    # -- action assignment ------------------------------------------------- #

    async def async_step_mode_actions(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Assign the actions of the mode currently being edited."""
        index = self._mode_index
        mode_key = str(index)
        errors: dict[str, str] = {}
        fields = self._action_fields(include_multiclick=not self._modeless)

        if user_input is not None:
            wheel_options = user_input.get(SECTION_WHEEL) or {}
            sequences: dict[str, list[Any]] = {}
            for action in fields:
                try:
                    sequences[action] = _validate_sequence(user_input.get(action))
                except vol.Invalid:
                    errors[action] = "invalid_sequence"
            name = str(user_input.get(CONF_MODE_NAME) or "").strip()
            if not name:
                errors[CONF_MODE_NAME] = "name_required"

            if not errors:
                self._set_mode_name(index, name)
                for action, sequence in sequences.items():
                    if action == ACTION_WHEEL:
                        self._store_binding(
                            mode_key,
                            action,
                            sequence,
                            **{
                                CONF_SCRIPT_MODE: wheel_options.get(
                                    CONF_SCRIPT_MODE, DEFAULT_SCRIPT_MODE
                                ),
                                CONF_WHEEL_THROTTLE_MS: max(
                                    0,
                                    min(
                                        _as_int(
                                            wheel_options.get(CONF_WHEEL_THROTTLE_MS),
                                            _as_int(
                                                self._data.get(CONF_WHEEL_THROTTLE_MS),
                                                DEFAULT_WHEEL_THROTTLE_MS,
                                            ),
                                        ),
                                        MAX_WHEEL_THROTTLE_MS,
                                    ),
                                ),
                            },
                        )
                    else:
                        self._store_binding(mode_key, action, sequence)

                if self.source == SOURCE_RECONFIGURE:
                    return self._async_save_and_return()
                if index < self._mode_count:
                    self._mode_index = index + 1
                    return await self.async_step_mode_actions()
                if self._modeless:
                    return await self.async_step_multiclick()
                return self._async_finish()

        submitted_wheel: Mapping[str, Any] = (
            user_input.get(SECTION_WHEEL) or {} if user_input else {}
        )
        name_default = (
            str(user_input.get(CONF_MODE_NAME) or "")
            if user_input is not None
            else self._mode_name(index)
        ) or self._mode_name(index)

        schema_dict: dict[Any, Any] = {
            vol.Required(
                CONF_MODE_NAME,
                description={"suggested_value": name_default},
            ): _text_selector()
        }
        schema_dict.update(self._sequence_fields(mode_key, fields, user_input))
        schema_dict[vol.Required(SECTION_WHEEL)] = section(
            vol.Schema(
                {
                    vol.Required(
                        CONF_SCRIPT_MODE,
                        default=str(
                            submitted_wheel.get(CONF_SCRIPT_MODE)
                            or self._binding_option(
                                mode_key,
                                ACTION_WHEEL,
                                CONF_SCRIPT_MODE,
                                DEFAULT_SCRIPT_MODE,
                            )
                        ),
                    ): _select_selector(SCRIPT_MODES, "script_mode"),
                    vol.Required(
                        CONF_WHEEL_THROTTLE_MS,
                        default=_as_int(
                            submitted_wheel.get(
                                CONF_WHEEL_THROTTLE_MS,
                                self._binding_option(
                                    mode_key,
                                    ACTION_WHEEL,
                                    CONF_WHEEL_THROTTLE_MS,
                                    self._data.get(CONF_WHEEL_THROTTLE_MS),
                                ),
                            ),
                            DEFAULT_WHEEL_THROTTLE_MS,
                        ),
                    ): _number_selector(0, MAX_WHEEL_THROTTLE_MS, 10, "ms"),
                }
            ),
            {"collapsed": True},
        )

        return self.async_show_form(
            step_id="mode_actions",
            data_schema=vol.Schema(schema_dict),
            errors=errors,
            description_placeholders=self._placeholders(),
            last_step=(
                False
                if self.source == SOURCE_RECONFIGURE
                else index >= self._mode_count and not self._modeless
            ),
        )

    async def async_step_multiclick(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Assign the mode independent double and triple click."""
        errors: dict[str, str] = {}
        fields = (ACTION_DOUBLE, ACTION_TRIPLE)

        if user_input is not None:
            sequences: dict[str, list[Any]] = {}
            for action in fields:
                try:
                    sequences[action] = _validate_sequence(user_input.get(action))
                except vol.Invalid:
                    errors[action] = "invalid_sequence"
            if not errors:
                for action, sequence in sequences.items():
                    self._store_binding(MODELESS_MODE_KEY, action, sequence)
                if self.source == SOURCE_RECONFIGURE:
                    return self._async_save_and_return()
                return self._async_finish()

        schema = vol.Schema(self._sequence_fields(MODELESS_MODE_KEY, fields, user_input))
        return self.async_show_form(
            step_id="multiclick",
            data_schema=schema,
            errors=errors,
            description_placeholders=self._placeholders(),
            last_step=self.source != SOURCE_RECONFIGURE,
        )

    def _action_fields(self, include_multiclick: bool) -> tuple[str, ...]:
        """Return the action keys editable in a mode step."""
        fields: list[str] = []
        if self._split_click:
            fields.extend((ACTION_CLICK_ON, ACTION_CLICK_OFF))
        else:
            fields.append(ACTION_CLICK)
        if include_multiclick:
            fields.extend((ACTION_DOUBLE, ACTION_TRIPLE))
        fields.append(ACTION_WHEEL)
        return tuple(fields)

    def _sequence_fields(
        self,
        mode_key: str,
        fields: Iterable[str],
        user_input: dict[str, Any] | None,
    ) -> dict[Any, Any]:
        """Build the action selector part of a schema."""
        schema: dict[Any, Any] = {}
        editor = _sequence_selector()
        for action in fields:
            if user_input is not None and action in user_input:
                current = user_input.get(action)
            else:
                current = self._binding(mode_key, action)
            schema[vol.Optional(action, description={"suggested_value": current})] = editor
        return schema

    # -- persistence ------------------------------------------------------- #

    def _entry_payload(self) -> dict[str, Any]:
        """Return the complete subentry payload."""
        count = self._mode_count
        names = [self._mode_name(index) for index in range(1, count + 1)]
        payload = dict(self._data)
        payload[CONF_MODE_NAMES] = names
        payload[CONF_MAPPINGS] = {
            key: dict(value) for key, value in self._mappings.items() if value
        }
        payload[CONF_SCHEMA_VERSION] = SCHEMA_VERSION
        return payload

    @callback
    def _async_finish(self) -> SubentryFlowResult:
        """Create the subentry."""
        return self.async_create_entry(
            title=self._remote_name,
            data=self._entry_payload(),
            unique_id=str(self._data.get(CONF_IEEE)),
        )

    @callback
    def _async_save_and_return(self) -> SubentryFlowResult:
        """Persist the current state and return to the reconfigure menu."""
        entry = self._get_entry()
        subentry = self._get_reconfigure_subentry()
        payload = self._entry_payload()
        update = getattr(self.hass.config_entries, "async_update_subentry", None)
        if update is None:  # pragma: no cover - defensive, API exists since 2025.2
            return self.async_update_and_abort(
                entry, subentry, data=payload, title=self._remote_name
            )
        update(entry, subentry, data=payload, title=self._remote_name)
        return self._async_menu()

    # -- reconfiguration --------------------------------------------------- #

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Open the reconfigure menu of an existing remote."""
        await _async_ensure_images(self.hass)
        subentry = self._get_reconfigure_subentry()
        self._load(subentry)
        return self._async_menu()

    @callback
    def _async_menu(self) -> SubentryFlowResult:
        """Show the reconfigure menu."""
        options = ["options"]
        options += [f"mode_{index}" for index in range(1, self._mode_count + 1)]
        if self._modeless:
            options.append("multiclick")
        options.append("finish")
        return self.async_show_menu(
            step_id="reconfigure",
            menu_options=options,
            description_placeholders=self._placeholders(),
        )

    async def async_step_finish(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Close the reconfigure menu."""
        return self.async_abort(reason="reconfigure_successful")

    def _load(self, subentry: ConfigSubentry) -> None:
        """Load an existing subentry into the flow state."""
        data = dict(subentry.data)
        raw_mappings = data.pop(CONF_MAPPINGS, None)
        if not isinstance(raw_mappings, Mapping):
            raw_mappings = data.pop("modes", None)
        self._mappings = {
            str(key): dict(value)
            for key, value in (raw_mappings or {}).items()
            if isinstance(value, Mapping)
        }
        raw_names = data.pop(CONF_MODE_NAMES, None) or []
        if isinstance(raw_names, str) or not isinstance(raw_names, (list, tuple)):
            raw_names = []
        self._mode_names = [str(name) for name in raw_names]
        data.pop(CONF_SCHEMA_VERSION, None)
        self._data = data
        self._data.setdefault(CONF_NAME, subentry.title)


def _make_mode_step(index: int) -> Any:
    """Build the menu entry point for one mode.

    The reconfigure menu needs one step id per mode, but the form itself is the
    shared ``mode_actions`` step -- so translations stay in one place.
    """

    async def _async_step(
        self: RemoteSubentryFlow, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        self._mode_index = index
        return await self.async_step_mode_actions(user_input)

    _async_step.__name__ = f"async_step_mode_{index}"
    _async_step.__doc__ = f"Edit the actions of mode {index}."
    return _async_step


for _index in range(1, MAX_MODE_COUNT + 1):
    setattr(RemoteSubentryFlow, f"async_step_mode_{_index}", _make_mode_step(_index))
del _index
