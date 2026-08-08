"""Constants for the IKEA BILRESA Remote integration.

This module is the shared contract between all other modules. Nothing here may
depend on Home Assistant internals so it stays importable from tests and tools.

Protocol facts encoded below were measured against real hardware (Z2M 2.13.0,
IKEA E2490); see docs/PROTOCOL.md for the raw captures.
"""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "bilresa_remote"

# --------------------------------------------------------------------------- #
# Config entry / subentry keys
# --------------------------------------------------------------------------- #

SUBENTRY_TYPE_REMOTE: Final = "remote"
SUBENTRY_TYPE_AWTRIX_SLOT: Final = "awtrix_slot"

CONF_BASE_TOPIC: Final = "base_topic"
CONF_IEEE: Final = "ieee"
CONF_NAME: Final = "name"
CONF_COLOR: Final = "color"
CONF_MODE_SOURCE: Final = "mode_source"
CONF_MODE_COUNT: Final = "mode_count"
CONF_MODE_NAMES: Final = "mode_names"
CONF_GROUP_IDS: Final = "group_ids"
CONF_MODE_CYCLE_ACTION: Final = "mode_cycle_action"
CONF_SPLIT_SINGLE_CLICK: Final = "split_single_click"
CONF_WHEEL_THROTTLE_MS: Final = "wheel_throttle_ms"
CONF_MAPPINGS: Final = "mappings"
CONF_SEQUENCE: Final = "sequence"
CONF_SCRIPT_MODE: Final = "script_mode"

# Per-remote switch requested by the user: should double/triple click be tied to
# the last known mode, or act mode-independently? Both are supported, per remote.
CONF_MODELESS_MULTICLICK: Final = "modeless_multiclick"

DEFAULT_BASE_TOPIC: Final = "zigbee2mqtt"
DEFAULT_MODE_COUNT: Final = 3
DEFAULT_WHEEL_THROTTLE_MS: Final = 120
DEFAULT_MODELESS_MULTICLICK: Final = True
DEFAULT_SPLIT_SINGLE_CLICK: Final = False

# --------------------------------------------------------------------------- #
# Mode sources
# --------------------------------------------------------------------------- #

MODE_SOURCE_DEVICE: Final = "device"
MODE_SOURCE_INTERNAL: Final = "internal"
MODE_SOURCE_HYBRID: Final = "hybrid"
MODE_SOURCES: Final = (MODE_SOURCE_HYBRID, MODE_SOURCE_DEVICE, MODE_SOURCE_INTERNAL)
DEFAULT_MODE_SOURCE: Final = MODE_SOURCE_HYBRID

# The E2490 firmware groupcasts to these fixed Zigbee group IDs, one per internal
# channel. Configurable anyway — never assume a vendor constant is forever.
DEFAULT_GROUP_IDS: Final = (21658, 21659, 21660)

# --------------------------------------------------------------------------- #
# Action taxonomy
#
# Raw Z2M values are normalised to this internal vocabulary. It is the interface
# towards configuration, the event entity and the docs; it stays stable even if
# Z2M reshuffles its converters.
# --------------------------------------------------------------------------- #

ACTION_CLICK: Final = "click"
ACTION_CLICK_ON: Final = "click_on"
ACTION_CLICK_OFF: Final = "click_off"
ACTION_DOUBLE: Final = "double"
ACTION_TRIPLE: Final = "triple"
ACTION_WHEEL: Final = "wheel"

#: Actions that can be bound to a script in the UI.
BINDABLE_ACTIONS: Final = (
    ACTION_CLICK,
    ACTION_CLICK_ON,
    ACTION_CLICK_OFF,
    ACTION_DOUBLE,
    ACTION_TRIPLE,
    ACTION_WHEEL,
)

#: Raw Z2M ``action`` value -> internal action.
#: A single click alternates on/off; the device keeps that state per channel, so
#: both map to ACTION_CLICK unless the user opts into splitting them.
RAW_TO_ACTION: Final = {
    "on": ACTION_CLICK_ON,
    "off": ACTION_CLICK_OFF,
    "on_double": ACTION_DOUBLE,
    "off_double": ACTION_TRIPLE,
    "brightness_move_to_level": ACTION_WHEEL,
}

#: Actions whose payload never carries ``action_group``. Measured, not assumed:
#: double/triple click are sent unicast to the bound coordinator, so Z2M cannot
#: attribute a group. Everything else is a groupcast and does carry it.
ACTIONS_WITHOUT_MODE: Final = frozenset({ACTION_DOUBLE, ACTION_TRIPLE})

#: Event types fired by the event entity.
EVENT_TYPES: Final = (
    ACTION_CLICK,
    ACTION_CLICK_ON,
    ACTION_CLICK_OFF,
    ACTION_DOUBLE,
    ACTION_TRIPLE,
    "wheel_up",
    "wheel_down",
)

# --------------------------------------------------------------------------- #
# MQTT payload fields
# --------------------------------------------------------------------------- #

FIELD_ACTION: Final = "action"
FIELD_ACTION_GROUP: Final = "action_group"
FIELD_ACTION_LEVEL: Final = "action_level"
FIELD_BATTERY: Final = "battery"
FIELD_LINKQUALITY: Final = "linkquality"

#: ``action_level: null`` is the ZCL "non value" 0xFF and means 255. Z2M has
#: emitted null here since ~2.8; failing to map it crashes level handling.
WHEEL_LEVEL_NULL_FALLBACK: Final = 255
WHEEL_LEVEL_MIN: Final = 1
WHEEL_LEVEL_MAX: Final = 255

# --------------------------------------------------------------------------- #
# Device metadata
# --------------------------------------------------------------------------- #

MANUFACTURER: Final = "IKEA"
MODEL_WHEEL: Final = "E2490"
MODEL_WHEEL_NAME: Final = "BILRESA remote control with scroll wheel"
SUPPORTED_MODELS: Final = (MODEL_WHEEL,)

#: Housing colours we ship an illustration for. Keys are stable identifiers used
#: in config; labels live in translations.
COLORS: Final = ("red", "beige", "green", "white")
DEFAULT_COLOR: Final = "beige"
IMAGE_PATH: Final = f"/{DOMAIN}/images"

# --------------------------------------------------------------------------- #
# Signals / storage
# --------------------------------------------------------------------------- #

SIGNAL_ACTION: Final = f"{DOMAIN}_action"
SIGNAL_MODE_CHANGED: Final = f"{DOMAIN}_mode_changed"

ISSUE_CHANNELS_LOCKED: Final = "channels_locked"
ISSUE_INVALID_SEQUENCE: Final = "invalid_sequence"

ATTR_REMOTE_ID: Final = "remote_id"
ATTR_MODE: Final = "mode"
ATTR_MODE_NAME: Final = "mode_name"
ATTR_MODE_SOURCE: Final = "mode_source"
ATTR_LEVEL: Final = "level"
ATTR_LEVEL_PCT: Final = "level_pct"
ATTR_LEVEL_254: Final = "level_254"
ATTR_PREVIOUS_LEVEL: Final = "previous_level"
ATTR_DELTA: Final = "delta"
ATTR_DIRECTION: Final = "direction"
ATTR_ACTION: Final = "action"
ATTR_ACTION_GROUP: Final = "action_group"

#: Set on an action that ``mode.py`` consumed to advance the mode. The
#: dispatcher uses it to suppress the script bound to that same press, so the
#: configured cycle action does not fire a binding on every mode change.
ATTR_IS_MODE_CYCLE: Final = "is_mode_cycle"
