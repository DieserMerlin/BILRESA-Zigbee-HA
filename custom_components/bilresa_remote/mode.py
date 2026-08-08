"""Mode resolution for a single BILRESA remote.

The E2490 has three internal channels, but they are only observable indirectly:

* ``action_group`` is present on ``on`` / ``off`` / ``brightness_move_to_level``
  and absent on ``on_double`` / ``off_double`` (measured, not assumed),
* the lower button switches the channel without sending anything at all,
* and the channels only exist once the user performed the physical Touchlink
  unlock -- which most users never do.

Design doc section 2.3 therefore abstracts the mode away from the hardware into
three sources:

``device``
    Mode comes from ``action_group``. Payloads without a group keep the last
    known mode.
``internal``
    Mode is cycled by a configurable action (triple click by default) and
    ``action_group`` is ignored entirely. Works without any Touchlink unlock.
``hybrid``
    Starts out as ``internal``. As soon as an ``action_group`` other than the
    first configured group id is observed, the resolver permanently promotes
    itself to ``device`` and raises a repair issue.

The resolver owns the mode of one remote. It is deliberately synchronous on the
hot path: it is called from the MQTT callback and must not await anything.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.dispatcher import (
    async_dispatcher_connect,
    async_dispatcher_send,
)
from homeassistant.helpers.event import async_track_point_in_utc_time
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    ACTION_TRIPLE,
    BINDABLE_ACTIONS,
    CONF_GROUP_IDS,
    CONF_MODE_COUNT,
    CONF_MODE_CYCLE_ACTION,
    CONF_MODE_NAMES,
    CONF_MODE_SOURCE,
    DEFAULT_GROUP_IDS,
    DEFAULT_MODE_COUNT,
    DEFAULT_MODE_SOURCE,
    DOMAIN,
    ISSUE_CHANNELS_LOCKED,
    MODE_SOURCE_DEVICE,
    MODE_SOURCE_HYBRID,
    MODE_SOURCES,
    SIGNAL_MODE_CHANGED,
)

_LOGGER = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Local contract additions (not present in const.py -- see module report)
# --------------------------------------------------------------------------- #

#: Subentry key for "wrap around at the last mode". Documented in the design doc
#: (section 3.2) but missing from const.py.
CONF_MODE_CYCLE_WRAP: Final = "cycle_wrap"
DEFAULT_MODE_CYCLE_WRAP: Final = True

#: Repair issue raised when ``hybrid`` promotes itself to ``device``.
#: const.py only defines ISSUE_CHANNELS_LOCKED / ISSUE_INVALID_SEQUENCE.
ISSUE_CHANNELS_DETECTED: Final = "channels_detected"

#: Upper sanity bound for ``mode_count``; the hardware has three channels but
#: ``internal`` mode is not bound by that.
MAX_MODE_COUNT: Final = 9

#: How long a ``device`` remote may stay on channel 1 before we tell the user
#: that the Touchlink unlock is probably missing (design doc section 2.3).
CHANNEL_PROBE_PERIOD: Final = timedelta(days=30)

TUTORIAL_URL: Final = (
    "https://github.com/DieserMerlin/BILRESA-Zigbee-HA#unlocking-the-device-channels"
)

STORAGE_VERSION: Final = 1
STORAGE_KEY: Final = f"{DOMAIN}.modes"
STORAGE_SAVE_DELAY: Final = 5
_STORE_HASS_KEY: Final = f"{DOMAIN}_mode_store"

# Why a mode change happened; carried on ModeChange for entities and logging.
REASON_DEVICE: Final = "device"
REASON_CYCLE: Final = "cycle"
REASON_MANUAL: Final = "manual"
REASON_RESTORE: Final = "restore"
REASON_PROMOTED: Final = "promoted"
REASON_CONFIG: Final = "config"


def _coerce_int(value: Any, default: int | None = None) -> int | None:
    """Best-effort int conversion that never raises."""
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip(), 0)
        except ValueError:
            return default
    return default


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class ModeConfig:
    """Mode related part of a ``remote`` subentry, already sanitised."""

    source: str = DEFAULT_MODE_SOURCE
    count: int = DEFAULT_MODE_COUNT
    names: tuple[str, ...] = ()
    group_ids: tuple[int, ...] = DEFAULT_GROUP_IDS
    cycle_action: str = ACTION_TRIPLE
    cycle_wrap: bool = DEFAULT_MODE_CYCLE_WRAP

    @classmethod
    def from_data(cls, data: Mapping[str, Any]) -> ModeConfig:
        """Build a config from raw subentry data, tolerating garbage."""
        source = data.get(CONF_MODE_SOURCE) or DEFAULT_MODE_SOURCE
        if source not in MODE_SOURCES:
            _LOGGER.warning(
                "Unknown mode source %r, falling back to %s", source, DEFAULT_MODE_SOURCE
            )
            source = DEFAULT_MODE_SOURCE

        count = _coerce_int(data.get(CONF_MODE_COUNT), DEFAULT_MODE_COUNT) or DEFAULT_MODE_COUNT
        count = max(1, min(count, MAX_MODE_COUNT))

        raw_names = data.get(CONF_MODE_NAMES) or ()
        if isinstance(raw_names, str) or not isinstance(raw_names, Sequence):
            raw_names = ()
        names = tuple(str(name) for name in raw_names)

        raw_groups = data.get(CONF_GROUP_IDS) or DEFAULT_GROUP_IDS
        if isinstance(raw_groups, (str, bytes)) or not isinstance(raw_groups, Sequence):
            raw_groups = DEFAULT_GROUP_IDS
        groups = tuple(
            group for group in (_coerce_int(item) for item in raw_groups) if group is not None
        )
        if not groups:
            groups = DEFAULT_GROUP_IDS

        cycle_action = data.get(CONF_MODE_CYCLE_ACTION) or ACTION_TRIPLE
        if cycle_action not in BINDABLE_ACTIONS:
            _LOGGER.warning(
                "Unknown mode cycle action %r, falling back to %s", cycle_action, ACTION_TRIPLE
            )
            cycle_action = ACTION_TRIPLE

        return cls(
            source=source,
            count=count,
            names=names,
            group_ids=groups,
            cycle_action=cycle_action,
            cycle_wrap=bool(data.get(CONF_MODE_CYCLE_WRAP, DEFAULT_MODE_CYCLE_WRAP)),
        )

    def name_for(self, mode: int) -> str:
        """Return the user facing name of a 1-based mode."""
        if 1 <= mode <= len(self.names):
            name = self.names[mode - 1].strip()
            if name:
                return name
        return f"Mode {mode}"

    @property
    def mode_names(self) -> tuple[str, ...]:
        """Return names for all modes, filling in defaults where needed."""
        return tuple(self.name_for(mode) for mode in range(1, self.count + 1))


# --------------------------------------------------------------------------- #
# Dispatcher payload
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class ModeChange:
    """Payload sent over :data:`SIGNAL_MODE_CHANGED`."""

    remote_id: str
    mode: int
    mode_name: str
    mode_source: str
    previous_mode: int | None
    reason: str


@dataclass(frozen=True, slots=True)
class ModeResolution:
    """Result of resolving one incoming action against the mode state."""

    mode: int
    mode_name: str
    mode_source: str
    changed: bool
    #: True when the action was consumed as the mode cycle trigger. The
    #: dispatcher uses this to decide whether the action may also run a script.
    is_mode_cycle: bool


@callback
def async_subscribe_mode_changes(
    hass: HomeAssistant,
    remote_id: str | None,
    target: Callable[[ModeChange], None],
) -> CALLBACK_TYPE:
    """Subscribe to mode changes, optionally filtered to one remote."""

    @callback
    def _handle(change: ModeChange) -> None:
        if remote_id is None or change.remote_id == remote_id:
            target(change)

    return async_dispatcher_connect(hass, SIGNAL_MODE_CHANGED, _handle)


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #


class BilresaModeStore:
    """Tiny shared store for per-remote mode bookkeeping.

    Only non-configuration runtime state lives here: the last active mode (so
    the resolver is correct before the select entity restored itself), whether
    device channels were ever observed, and when ``device`` mode started -- the
    latter two drive the repair issues and must survive restarts to be useful.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise the store."""
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict[str, dict[str, Any]] = {}
        self._loaded = False
        self._lock = asyncio.Lock()

    async def async_load(self) -> None:
        """Load the store once; failures degrade to in-memory operation."""
        async with self._lock:
            if self._loaded:
                return
            raw: Any = None
            try:
                raw = await self._store.async_load()
            except Exception:  # noqa: BLE001 - a corrupt store must not kill setup
                _LOGGER.exception("Could not read %s, starting with empty mode state", STORAGE_KEY)
            if isinstance(raw, dict):
                remotes = raw.get("remotes")
                if isinstance(remotes, dict):
                    self._data = {
                        str(key): dict(value)
                        for key, value in remotes.items()
                        if isinstance(value, dict)
                    }
            self._loaded = True

    @callback
    def async_get(self, remote_id: str) -> dict[str, Any]:
        """Return a copy of the stored state of one remote."""
        return dict(self._data.get(remote_id, {}))

    @callback
    def async_update(self, remote_id: str, **values: Any) -> None:
        """Merge values into the stored state and schedule a save."""
        entry = self._data.setdefault(remote_id, {})
        if all(entry.get(key) == value for key, value in values.items()):
            return
        entry.update(values)
        self._store.async_delay_save(self._data_to_save, STORAGE_SAVE_DELAY)

    @callback
    def async_remove(self, remote_id: str) -> None:
        """Drop the state of a removed remote."""
        if self._data.pop(remote_id, None) is not None:
            self._store.async_delay_save(self._data_to_save, STORAGE_SAVE_DELAY)

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        return {"remotes": self._data}


@callback
def async_get_mode_store(hass: HomeAssistant) -> BilresaModeStore:
    """Return the process wide mode store, creating it on first use."""
    store = hass.data.get(_STORE_HASS_KEY)
    if not isinstance(store, BilresaModeStore):
        store = BilresaModeStore(hass)
        hass.data[_STORE_HASS_KEY] = store
    return store


# --------------------------------------------------------------------------- #
# Resolver
# --------------------------------------------------------------------------- #


class ModeResolver:
    """Owns the active mode of one remote."""

    def __init__(
        self,
        hass: HomeAssistant,
        remote_id: str,
        config: ModeConfig,
        *,
        store: BilresaModeStore | None = None,
    ) -> None:
        """Initialise the resolver; no I/O happens here."""
        self.hass = hass
        self.remote_id = remote_id
        self._config = config
        self._store = store
        self._mode = 1
        self._promoted = False
        self._device_channels_seen = False
        self._device_since: datetime | None = None
        self._unsub_probe: CALLBACK_TYPE | None = None
        self._loaded = False
        self._warned_groups: set[int] = set()

    # -- properties -------------------------------------------------------- #

    @property
    def config(self) -> ModeConfig:
        """Return the current mode configuration."""
        return self._config

    @property
    def current(self) -> int:
        """Return the active 1-based mode."""
        return self._mode

    @property
    def mode_name(self) -> str:
        """Return the name of the active mode."""
        return self._config.name_for(self._mode)

    @property
    def mode_names(self) -> tuple[str, ...]:
        """Return the names of all modes."""
        return self._config.mode_names

    @property
    def mode_count(self) -> int:
        """Return how many modes this remote has."""
        return self._config.count

    @property
    def mode_source(self) -> str:
        """Return the effective mode source.

        ``hybrid`` reports ``device`` once it promoted itself, because that is
        what actually drives the mode from then on.
        """
        if self._config.source == MODE_SOURCE_HYBRID and self._promoted:
            return MODE_SOURCE_DEVICE
        return self._config.source

    @property
    def device_channels_seen(self) -> bool:
        """Return True when a group other than the first one was ever seen."""
        return self._device_channels_seen

    @property
    def cycle_action(self) -> str:
        """Return the action that cycles the mode (only used by non-device)."""
        return self._config.cycle_action

    @property
    def cycles_on_action(self) -> bool:
        """Return True when an action can cycle the mode at all."""
        return self.mode_source != MODE_SOURCE_DEVICE

    # -- lifecycle --------------------------------------------------------- #

    async def async_load(self) -> None:
        """Restore persisted state and arm the channel probe."""
        if self._loaded:
            return
        self._loaded = True

        if self._store is None:
            self._store = async_get_mode_store(self.hass)
        await self._store.async_load()

        stored = self._store.async_get(self.remote_id)
        mode = _coerce_int(stored.get("mode"))
        if mode is not None and 1 <= mode <= self._config.count:
            self._mode = mode
        self._device_channels_seen = bool(stored.get("device_channels_seen"))
        self._promoted = bool(stored.get("promoted")) and self._config.source == MODE_SOURCE_HYBRID
        since = stored.get("device_since")
        if isinstance(since, str):
            self._device_since = dt_util.parse_datetime(since)

        self._async_arm_channel_probe()

    @callback
    def async_shutdown(self) -> None:
        """Cancel timers. Safe to call more than once."""
        if self._unsub_probe is not None:
            self._unsub_probe()
            self._unsub_probe = None

    @callback
    def async_update_config(self, config: ModeConfig) -> None:
        """Apply a changed configuration without recreating the resolver."""
        self._config = config
        if config.source != MODE_SOURCE_HYBRID:
            self._promoted = False
        if self._mode > config.count:
            self._async_set_mode(config.count, REASON_CONFIG)
        self._async_persist()
        self._async_arm_channel_probe()

    # -- public mode control ----------------------------------------------- #

    @callback
    def async_set_mode(self, mode: int, *, reason: str = REASON_MANUAL) -> bool:
        """Set the mode explicitly. Returns True when it changed."""
        if not 1 <= mode <= self._config.count:
            _LOGGER.warning(
                "Ignoring out of range mode %s for %s (1..%s)",
                mode,
                self.remote_id,
                self._config.count,
            )
            return False
        return self._async_set_mode(mode, reason)

    @callback
    def async_restore_mode(self, mode: int) -> None:
        """Restore the mode at startup without announcing a change.

        Used by the select entity, which is the authority across restarts.
        """
        if 1 <= mode <= self._config.count and mode != self._mode:
            self._mode = mode
            self._async_persist()

    @callback
    def async_cycle(self, step: int = 1) -> int:
        """Advance the mode by ``step`` and return the new mode."""
        count = self._config.count
        if count <= 1:
            return self._mode
        if self._config.cycle_wrap:
            target = (self._mode - 1 + step) % count + 1
        else:
            target = max(1, min(count, self._mode + step))
        self._async_set_mode(target, REASON_CYCLE)
        return self._mode

    @callback
    def async_mode_for_group(self, action_group: int | None) -> int | None:
        """Map a Zigbee group id to a 1-based mode, or None if unknown."""
        if action_group is None:
            return None
        try:
            index = self._config.group_ids.index(action_group)
        except ValueError:
            return None
        mode = index + 1
        return mode if mode <= self._config.count else None

    # -- hot path ---------------------------------------------------------- #

    @callback
    def async_observe(self, action_group: int | None) -> bool:
        """Track a group id without letting any action cycle the mode.

        Used for payloads that are swallowed further downstream (the wheel
        calibration message, repeated identical levels): the mode must stay in
        sync even when the action itself is discarded.
        """
        self._async_note_group(action_group)

        if self.mode_source != MODE_SOURCE_DEVICE:
            return False

        mode = self.async_mode_for_group(action_group)
        if mode is not None:
            return self._async_set_mode(mode, REASON_DEVICE)
        if action_group is not None and action_group not in self._warned_groups:
            self._warned_groups.add(action_group)
            _LOGGER.warning(
                "Remote %s sent unknown action_group %s; configured groups are %s. "
                "Keeping mode %s",
                self.remote_id,
                action_group,
                ", ".join(str(gid) for gid in self._config.group_ids),
                self._mode,
            )
        return False

    @callback
    def async_resolve(self, action: str, action_group: int | None) -> ModeResolution:
        """Resolve one incoming action against the mode state.

        Called from the MQTT callback for every recognised action. It never
        raises and never awaits.
        """
        changed = self.async_observe(action_group)

        # Read after observing: a hybrid remote may just have been promoted.
        source = self.mode_source
        is_cycle = False

        if source != MODE_SOURCE_DEVICE and action == self._config.cycle_action:
            # internal / not yet promoted hybrid: the configured action is the
            # only way to change the mode.
            is_cycle = True
            changed = self._async_set_mode_from_cycle() or changed

        return ModeResolution(
            mode=self._mode,
            mode_name=self.mode_name,
            mode_source=source,
            changed=changed,
            is_mode_cycle=is_cycle,
        )

    # -- internals --------------------------------------------------------- #

    @callback
    def _async_set_mode_from_cycle(self) -> bool:
        before = self._mode
        self.async_cycle()
        return self._mode != before

    @callback
    def _async_set_mode(self, mode: int, reason: str) -> bool:
        if mode == self._mode:
            return False
        previous = self._mode
        self._mode = mode
        self._async_persist()
        _LOGGER.debug(
            "Remote %s switched to mode %s (%s) via %s",
            self.remote_id,
            mode,
            self.mode_name,
            reason,
        )
        async_dispatcher_send(
            self.hass,
            SIGNAL_MODE_CHANGED,
            ModeChange(
                remote_id=self.remote_id,
                mode=mode,
                mode_name=self.mode_name,
                mode_source=self.mode_source,
                previous_mode=previous,
                reason=reason,
            ),
        )
        return True

    @callback
    def _async_persist(self) -> None:
        if self._store is None:
            return
        self._store.async_update(
            self.remote_id,
            mode=self._mode,
            promoted=self._promoted,
            device_channels_seen=self._device_channels_seen,
            device_since=self._device_since.isoformat() if self._device_since else None,
        )

    @callback
    def _async_note_group(self, action_group: int | None) -> None:
        """Record evidence that the device channels are unlocked."""
        if action_group is None or not self._config.group_ids:
            return
        if action_group == self._config.group_ids[0]:
            return
        if action_group not in self._config.group_ids:
            # An unknown group is no proof that *our* channels are unlocked.
            return

        first_evidence = not self._device_channels_seen
        self._device_channels_seen = True
        if first_evidence:
            _LOGGER.info(
                "Remote %s uses device channel group %s; Touchlink unlock confirmed",
                self.remote_id,
                action_group,
            )
            self._async_clear_issue(ISSUE_CHANNELS_LOCKED)
            self.async_shutdown()

        if self._config.source == MODE_SOURCE_HYBRID and not self._promoted:
            self._async_promote()

        if first_evidence:
            self._async_persist()

    @callback
    def _async_promote(self) -> None:
        """Permanently switch a hybrid remote over to the device channels."""
        self._promoted = True
        if self._device_since is None:
            self._device_since = dt_util.utcnow()
        self._async_persist()
        _LOGGER.info(
            "Remote %s: device channels detected, mode source promoted to %s",
            self.remote_id,
            MODE_SOURCE_DEVICE,
        )
        ir.async_create_issue(
            self.hass,
            DOMAIN,
            self._issue_id(ISSUE_CHANNELS_DETECTED),
            is_fixable=False,
            is_persistent=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key=ISSUE_CHANNELS_DETECTED,
            translation_placeholders={"name": self.remote_id},
            learn_more_url=TUTORIAL_URL,
        )
        async_dispatcher_send(
            self.hass,
            SIGNAL_MODE_CHANGED,
            ModeChange(
                remote_id=self.remote_id,
                mode=self._mode,
                mode_name=self.mode_name,
                mode_source=MODE_SOURCE_DEVICE,
                previous_mode=self._mode,
                reason=REASON_PROMOTED,
            ),
        )

    @callback
    def _async_arm_channel_probe(self) -> None:
        """Schedule the "channels never unlocked" check for device remotes."""
        self.async_shutdown()

        if self.mode_source != MODE_SOURCE_DEVICE:
            self._async_clear_issue(ISSUE_CHANNELS_LOCKED)
            return
        if self._device_channels_seen:
            self._async_clear_issue(ISSUE_CHANNELS_LOCKED)
            return

        if self._device_since is None:
            self._device_since = dt_util.utcnow()
            self._async_persist()

        deadline = self._device_since + CHANNEL_PROBE_PERIOD
        if deadline <= dt_util.utcnow():
            self._async_raise_channels_locked()
            return
        self._unsub_probe = async_track_point_in_utc_time(
            self.hass, self._async_probe_expired, deadline
        )

    @callback
    def _async_probe_expired(self, _now: datetime) -> None:
        self._unsub_probe = None
        if self._device_channels_seen or self.mode_source != MODE_SOURCE_DEVICE:
            return
        self._async_raise_channels_locked()

    @callback
    def _async_raise_channels_locked(self) -> None:
        _LOGGER.warning(
            "Remote %s never sent a group other than %s in %s days; the device "
            "channels are most likely still locked",
            self.remote_id,
            self._config.group_ids[0] if self._config.group_ids else "?",
            CHANNEL_PROBE_PERIOD.days,
        )
        ir.async_create_issue(
            self.hass,
            DOMAIN,
            self._issue_id(ISSUE_CHANNELS_LOCKED),
            is_fixable=True,
            is_persistent=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key=ISSUE_CHANNELS_LOCKED,
            translation_placeholders={
                "name": self.remote_id,
                "days": str(CHANNEL_PROBE_PERIOD.days),
            },
            learn_more_url=TUTORIAL_URL,
            data={"remote_id": self.remote_id, "issue": ISSUE_CHANNELS_LOCKED},
        )

    @callback
    def _async_clear_issue(self, issue: str) -> None:
        ir.async_delete_issue(self.hass, DOMAIN, self._issue_id(issue))

    def _issue_id(self, issue: str) -> str:
        return f"{issue}_{self.remote_id}"

    @callback
    def async_remove(self) -> None:
        """Forget this remote entirely (subentry removed)."""
        self.async_shutdown()
        self._async_clear_issue(ISSUE_CHANNELS_LOCKED)
        self._async_clear_issue(ISSUE_CHANNELS_DETECTED)
        if self._store is not None:
            self._store.async_remove(self.remote_id)
