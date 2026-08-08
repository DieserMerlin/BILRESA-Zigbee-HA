"""Sidebar panel of the IKEA BILRESA Remote integration.

The panel is the primary user interface of this integration: remotes, modes and
action bindings are edited there instead of in config flow dialogs. This module
only owns the Home Assistant side of it -- serving the static files and putting
the entry into the sidebar. The panel itself is plain ES2022 in ``panel/``; the
files are delivered byte for byte as they are, there is no build step.

Two details are worth spelling out:

* **Cache busting.** The module URL carries the integration version as a query
  parameter. Without it a browser keeps the JavaScript of the previous release
  forever -- the file name never changes, so nothing else would invalidate it.
* **Idempotency.** Registering a static path twice makes aiohttp raise, and
  registering a panel twice makes the frontend raise. Both are guarded, so a
  reload of the config entry (or a second call from anywhere else) is free.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Final

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import translation
from homeassistant.loader import async_get_integration

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

#: Sidebar route. ``/bilresa`` is short on purpose -- it is what users bookmark.
PANEL_URL_PATH: Final = "bilresa"

#: URL prefix the panel directory is served under. The integration version is
#: appended as a path segment, not as a query string: the entry point pulls in
#: five sibling modules with plain relative imports, and only a versioned *path*
#: makes those inherit the cache buster too. With ``?v=`` on the entry point
#: alone, a browser could pair a new bilresa-panel.js with a stale styles.js.
PANEL_STATIC_URL: Final = f"/{DOMAIN}/panel"

#: Characters kept when a version string becomes part of a URL.
_SAFE_VERSION = re.compile(r"[^A-Za-z0-9._-]")

#: Directory holding the panel sources.
PANEL_DIR: Final = Path(__file__).parent / "panel"

#: Entry point module inside :data:`PANEL_DIR`.
PANEL_ENTRYPOINT: Final = "bilresa-panel.js"

#: Custom element the entry point defines. Contract with the frontend.
PANEL_ELEMENT: Final = "bilresa-panel"

PANEL_ICON: Final = "mdi:remote"

#: Used when the translations are unavailable (they are loaded lazily and a
#: missing language must never cost the user their sidebar entry).
FALLBACK_TITLE: Final = "BILRESA"

_FALLBACK_VERSION: Final = "0"

_DATA_STATIC_REGISTERED: Final = f"{DOMAIN}_panel_static_registered"
_DATA_PANEL_REGISTERED: Final = f"{DOMAIN}_panel_registered"


# --------------------------------------------------------------------------- #
# Registration
# --------------------------------------------------------------------------- #


async def async_register_panel(hass: HomeAssistant) -> None:
    """Serve the panel and add it to the sidebar.

    Safe to call more than once: the static path is registered at most once per
    process and the sidebar entry is replaced rather than duplicated.
    """
    version = _SAFE_VERSION.sub("-", await _async_version(hass)) or "dev"

    if not await _async_register_static(hass, version):
        return

    title = await _async_sidebar_title(hass)
    module_url = f"{PANEL_STATIC_URL}/{version}/{PANEL_ENTRYPOINT}"

    # Registering an existing panel raises; removing first keeps the call
    # idempotent and picks up a changed title or version on a reload.
    _async_remove_panel(hass)

    try:
        frontend.async_register_built_in_panel(
            hass,
            "custom",
            sidebar_title=title,
            sidebar_icon=PANEL_ICON,
            frontend_url_path=PANEL_URL_PATH,
            require_admin=True,
            config={
                "_panel_custom": {
                    "name": PANEL_ELEMENT,
                    "module_url": module_url,
                    "embed_iframe": False,
                    "trust_external": False,
                }
            },
        )
    except Exception:
        _LOGGER.exception("Could not add the BILRESA panel to the sidebar")
        return

    hass.data[_DATA_PANEL_REGISTERED] = True
    _LOGGER.debug("Panel registered at /%s from %s", PANEL_URL_PATH, module_url)


@callback
def async_unregister_panel(hass: HomeAssistant) -> None:
    """Remove the sidebar entry again.

    The static path stays registered: aiohttp cannot unregister routes, and a
    later setup would otherwise be unable to serve the panel at all.
    """
    _async_remove_panel(hass)
    hass.data[_DATA_PANEL_REGISTERED] = False


@callback
def _async_remove_panel(hass: HomeAssistant) -> None:
    """Drop the panel from the sidebar, tolerating that it is not there."""
    try:
        frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    except TypeError:
        # ``warn_if_unknown`` is newer than the rest of the signature.
        try:
            frontend.async_remove_panel(hass, PANEL_URL_PATH)
        except Exception:
            _LOGGER.debug("Could not remove the BILRESA panel", exc_info=True)
    except Exception:
        _LOGGER.debug("Could not remove the BILRESA panel", exc_info=True)


async def _async_register_static(hass: HomeAssistant, version: str) -> bool:
    """Serve :data:`PANEL_DIR` under a versioned URL exactly once."""
    url = f"{PANEL_STATIC_URL}/{version}"
    if hass.data.get(_DATA_STATIC_REGISTERED) == url:
        return True

    if not await hass.async_add_executor_job(PANEL_DIR.is_dir):
        _LOGGER.error(
            "Panel directory %s is missing, the BILRESA panel is not available",
            PANEL_DIR,
        )
        return False

    try:
        await hass.http.async_register_static_paths([StaticPathConfig(url, str(PANEL_DIR), False)])
    except RuntimeError:
        # Already served, e.g. after the integration was reloaded from disk.
        _LOGGER.debug("%s is already served", url)
    except Exception:
        _LOGGER.exception("Could not serve the panel from %s", PANEL_DIR)
        return False

    hass.data[_DATA_STATIC_REGISTERED] = url
    return True


# --------------------------------------------------------------------------- #
# Metadata
# --------------------------------------------------------------------------- #


async def _async_version(hass: HomeAssistant) -> str:
    """Return the integration version used to bust the browser cache."""
    try:
        integration = await async_get_integration(hass, DOMAIN)
    except Exception:
        _LOGGER.debug("Could not read the integration manifest", exc_info=True)
        return _FALLBACK_VERSION

    version: Any = getattr(integration, "version", None)
    if version is None:
        manifest = getattr(integration, "manifest", None) or {}
        version = manifest.get("version")
    text = str(version or "").strip()
    return text or _FALLBACK_VERSION


async def _async_sidebar_title(hass: HomeAssistant) -> str:
    """Return the localised sidebar title, falling back to ``BILRESA``."""
    try:
        translations = await translation.async_get_translations(
            hass, hass.config.language, "title", {DOMAIN}
        )
    except Exception:
        _LOGGER.debug("Could not read the panel title translation", exc_info=True)
        return FALLBACK_TITLE

    title = str(translations.get(f"component.{DOMAIN}.title") or "").strip()
    return title or FALLBACK_TITLE
