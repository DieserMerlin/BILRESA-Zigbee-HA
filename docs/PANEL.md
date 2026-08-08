# The panel

The panel is the primary user interface of this integration. It lives in the
sidebar as **BILRESA** (route `/bilresa`, admin only) and covers everything a
user does after the initial setup: adding remotes, configuring modes and binding
actions. The config flow only asks for the Zigbee2MQTT base topic.

This document is for contributors. It describes how the frontend is put
together, which rules it has to follow, and how to work on it without fighting
the browser cache.

## Where it is registered

`custom_components/bilresa_remote/panel.py` does the Home Assistant side:

- serves `custom_components/bilresa_remote/panel/` under `/bilresa_remote/panel`
  (`StaticPathConfig(..., cache_headers=False)`, registered once per process),
- registers a `custom` panel with
  `module_url = /bilresa_remote/panel/bilresa-panel.js?v=<manifest version>` and
  `require_admin=True`,
- is idempotent: the sidebar entry is removed before it is added again, so a
  config entry reload picks up a changed title or version instead of raising.

The housing illustrations are served separately by `__init__.py` under
`/bilresa_remote/images` (see `const.IMAGE_PATH`), because the config flow needs
them before any panel exists.

Home Assistant sets four properties on the custom element: `hass`, `narrow`,
`route` and `panel`. Nothing else is passed in, and nothing else may be assumed.

## File layout

| File | Role |
| --- | --- |
| `panel/bilresa-panel.js` | The shell and the entry point registered in `panel.py`. Owns routing, the overview, discovery, the live action strip, toasts and all state. Defines `<bilresa-panel>`. |
| `panel/remote-editor.js` | One remote: settings and the mode/action grid, including the action editor dialogs. Defines `<bilresa-remote-editor>`. |
| `panel/guide.js` | The manual: button reference, the Touchlink unlock, the multiclick explanation, troubleshooting. Defines `<bilresa-guide>`. |
| `panel/api.js` | The only module that talks to the websocket connection. One exported function per command in the contract, plus error normalisation. |
| `panel/styles.js` | `sharedStyles`, the design system as a plain string. Every shadow root drops it into its own `<style>`. |

Each view is a native custom element with an open shadow root. There is no base
class and no shared component library on purpose — the surface is small enough
that a shared abstraction would cost more than it saves.

## How the modules fit together

```
bilresa-panel.js  ── imports ──►  remote-editor.js
        │                          guide.js
        │                          api.js  ──►  hass.connection
        └── every module imports styles.js
```

- **State lives in the shell.** `bilresa-panel.js` calls
  `loadConfig()` once and keeps the whole `config` payload. Children never fetch
  the configuration themselves; they receive it as a property.
- **Props down.** The shell sets `hass` and `config` on both children, plus
  `remote` on the editor. Property setters, not attributes — the payloads are
  objects.
- **Events up.** A child that wrote something dispatches a bubbling, composed
  `changed` event. The shell listens on its shadow root and schedules a debounced
  `loadConfig()` (`_scheduleReload`, 150 ms), then re-renders. Children never
  mutate the config object they were given.
- **Live events.** The shell holds the single `subscribeEvents` subscription and
  renders the strip below the header. It re-subscribes when the connection
  object changes and unsubscribes in `disconnectedCallback`.

### Routing

`route.path` is parsed by `parsePath()` into three views:

| Path | View |
| --- | --- |
| `/` | overview |
| `/guide` | the guide |
| `/remote/<subentry_id>` | one remote |

Navigation goes through `_navigate()`, which pushes the state and fires a
`location-changed` event on `window` — that is what the Home Assistant router
listens to. Do not call `window.location.assign`; it would reload the frontend.

Views are rebuilt only when the view key changes; within a view the code patches
the existing DOM instead of re-creating it, so scroll position and focus survive
a config reload. `guide.js` follows the same rule with a content signature: it
only rebuilds when the group ids or the base topic actually changed.

## The websocket contract

[`custom_components/bilresa_remote/ws_contract.md`](../custom_components/bilresa_remote/ws_contract.md)
is the single source of truth for the API between the panel and the
integration. Both sides are written against it.

Rules that keep it honest:

1. **`api.js` is the only place that calls `hass.connection`.** No component may
   send a message directly. If a view needs data, it needs a function in
   `api.js`.
2. **No command, field or error code that the contract does not list.** The
   backend rejects unknown fields with `invalid_format`, and the panel must not
   send them in the first place. `remote/create` therefore copies a fixed field
   list; `remote/update` sends `changes` verbatim, so callers have to pass keys
   that exist in `config`.
3. **Branch on the documented error codes**, not on message text. Everything
   thrown by `api.js` is a `BilresaError` with `code` and `message`;
   `describeError()` turns it into something displayable.
4. **Changing the API means changing three files, in this order:**
   `ws_contract.md`, then `websocket.py`, then `api.js`. A change that starts in
   `api.js` will be rejected in review.
5. All commands require an admin connection. The panel is registered with
   `require_admin=True` so a non-admin never gets that far.

## Styling

- `styles.js` exports one big string. Import it and put it into the element's
  own `<style>`; shadow DOM means nothing leaks in or out, so every element
  needs its own copy.
- **Only Home Assistant CSS variables.** `--primary-color`,
  `--card-background-color`, `--primary-text-color`, `--secondary-text-color`,
  `--divider-color`, `--error-color`, `--success-color`,
  `--ha-card-border-radius` and friends, mapped once into local `--bil-*`
  tokens at the top of `sharedStyles`. Hard-coded colours are allowed for
  exactly one thing: the housing and LED colours of the remote illustrations.
  Everything else must follow the user's theme, light or dark, without a second
  code path.
- Layout is single column below 700 px, and every touch target is at least
  44 px high.
- Respect `prefers-reduced-motion`; `sharedStyles` already switches animations
  off, so do not re-enable them locally.
- Component-specific CSS stays in its module (see `guideStyles` in `guide.js`)
  and is concatenated after `sharedStyles`. Only move a rule into `styles.js`
  when a second module needs it.

## Why there is no bundler

The panel is plain ES2022 with native modules. There is no npm, no
`package.json`, no TypeScript, no Lit, no CDN and no web font.

- **The files are shipped byte for byte.** HACS copies
  `custom_components/bilresa_remote/` into the user's config directory, and
  `panel.py` serves that directory. What you read in the repository is what runs
  in the browser — no source maps, no build output to keep in sync, and a stack
  trace points at a real line number.
- **Nothing to install to contribute.** The CI runs `ruff` and `hassfest`; a
  frontend toolchain would double the setup for a few thousand lines of DOM
  code.
- **It has to work offline.** Home Assistant installations are frequently
  isolated. Anything fetched from a CDN at runtime is out of the question, and
  vendoring a library would end up in the diff of every release.

Consequences to keep in mind:

- Imports are relative and carry the `.js` extension (`./api.js`). Bare
  specifiers do not resolve in a browser.
- No JSX, no decorators, no TypeScript syntax. Optional chaining, class fields
  and top-level `await` are fine; the browser is whatever Home Assistant 2026.6
  supports.
- No transpilation means no polyfills either. `color-mix()`, `aspect-ratio` and
  `:focus-visible` are used deliberately and are safe in that baseline.
- The DOM is built with a small local `h()` helper in each module. Duplicating
  those twenty lines is intentional: it keeps modules independent, and a shared
  helper module would be one more import for no gain.

## Working on the panel

Point a development Home Assistant at the repository (symlink
`custom_components/bilresa_remote` into `<config>/custom_components/`). JavaScript
is read from disk on every request, so a Python restart is only needed for
Python changes.

### Getting around the browser cache

Two caches are in play, and they need different treatment.

1. **The HTTP cache.** The static path is registered with `cache_headers=False`,
   so Home Assistant does not send far-future caching headers for the panel
   files. A normal reload usually re-fetches them, a hard reload
   (Ctrl/Cmd + Shift + R) always does. During a session of frontend work, open
   DevTools and tick **Network → Disable cache**; it applies as long as DevTools
   stays open.
2. **The module map.** A browser imports a module URL exactly once per document.
   Navigating away from the panel and back does *not* re-import it — only a full
   page reload does. That is the usual reason an edit "does not show up".

The version query parameter (`?v=<manifest version>`) is what makes a released
change reach users: the URL changes with every release, so the old module cannot
be reused. It is baked into the panel registration when the config entry is set
up, so after bumping `manifest.json` reload the integration (Settings → Devices
& services → three-dot menu → **Reload**) and then reload the browser page.

For a stubborn cache during development, appending your own parameter to the
address (`/bilresa?x=1`) does not help — the module URL comes from the panel
registration, not from the address bar. Hard reload is the reliable tool.

### Checks before opening a pull request

- `node --check panel/<file>.js` on every file you touched. There is no test
  runner for the frontend; a syntax check plus a careful read is the bar.
- Click through the panel in **both** themes and at a narrow viewport
  (≤ 700 px). A hard-coded colour shows up immediately in the dark theme.
- Watch the browser console. The panel must be silent in normal operation; the
  only expected message is the guarded `console.error` in `subscribeEvents`.
- Keyboard: every interactive element must be reachable with Tab and show a
  visible focus ring (`:focus-visible` is styled in `sharedStyles`).
- If you touched the API surface, re-read `ws_contract.md` and check that no new
  field crept in.
