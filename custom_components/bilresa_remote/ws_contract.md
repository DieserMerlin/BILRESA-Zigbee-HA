# WebSocket contract between the panel and the integration

This file is the single source of truth for the panel API. Backend and frontend
are written against it; neither side may invent a command or field that is not
listed here.

All commands are registered with `websocket_api.async_register_command` and
require an admin connection (`@websocket_api.require_admin`).

---

## `bilresa_remote/config`

Read the whole configuration in one round trip.

**Request:** `{ "type": "bilresa_remote/config" }`

**Response:**

```jsonc
{
  "base_topic": "zigbee2mqtt",
  "colors": ["red", "beige", "green"],
  "actions": ["click", "click_on", "click_off", "double", "triple", "wheel"],
  "mode_sources": ["hybrid", "device", "internal"],
  "modeless_key": "*",
  "remotes": [
    {
      "subentry_id": "01ABC…",
      "ieee": "0x1035970000a197b8",
      "name": "Kitchen",
      "color": "red",
      "mode_source": "hybrid",
      "effective_mode_source": "device",   // after hybrid promotion
      "mode_count": 3,
      "mode_names": ["Kitchen", "Light", "AWTRIX"],
      "modeless_multiclick": true,
      "split_single_click": false,
      "wheel_throttle_ms": 120,
      "mode_cycle_action": "triple",
      "cycle_wrap": true,
      "group_ids": [21658, 21659, 21660],
      "current_mode": 1,
      "available": true,                    // false if the device vanished from Z2M
      "bindings": {
        // key is "<mode>" (1-based) or "*" for mode-independent slots
        "1": { "click": { "sequence": [ … ], "script_mode": "single" } },
        "*": { "double": { "sequence": [ … ], "script_mode": "single" } }
      }
    }
  ]
}
```

## `bilresa_remote/discover`

List BILRESA remotes seen by Zigbee2MQTT.

**Request:** `{ "type": "bilresa_remote/discover", "force": false }`

**Response:**

```jsonc
{
  "devices": [
    {
      "ieee": "0x1035970000a197b8",
      "friendly_name": "0x1035970000a197b8",
      "comment": "Rot",          // free-text device comment from Z2M
      "model": "E2490",
      "label": "Rot - 0x1035970000a197b8 (E2490)",
      "suggested_color": "red",
      "configured": true          // already has a subentry
    }
  ],
  "z2m_available": true
}
```

## `bilresa_remote/remote/create`

**Request:** `{ "type": …, "ieee": …, "name": …, "color": …, "mode_source": …,
"mode_count": 3, "mode_names": [...], "modeless_multiclick": true }`
All fields except `ieee` are optional and fall back to defaults.

**Response:** `{ "subentry_id": "01ABC…" }`

## `bilresa_remote/remote/update`

**Request:** `{ "type": …, "subentry_id": …, "changes": { … } }`
`changes` may carry any of the settings fields from `config`. Unknown keys are
rejected with `invalid_format`.

**Response:** `{ "success": true }` — the integration rebuilds only what changed;
it never reloads the whole config entry.

## `bilresa_remote/remote/delete`

**Request:** `{ "type": …, "subentry_id": … }` → **Response:** `{ "success": true }`

## `bilresa_remote/binding/set`

**Request:**

```jsonc
{
  "type": "bilresa_remote/binding/set",
  "subentry_id": "01ABC…",
  "mode_key": "1",              // or "*"
  "action": "click",
  "sequence": [ … ],            // Home Assistant script sequence
  "script_mode": "single"       // optional
}
```

The sequence is validated with `async_validate_actions_config` **before** it is
stored. On failure the command returns error code `invalid_sequence` with the
validation message in `message`, and nothing is written.

**Response:** `{ "success": true }`

## `bilresa_remote/binding/clear`

**Request:** `{ "type": …, "subentry_id": …, "mode_key": …, "action": … }`

## `bilresa_remote/binding/test`

Run a stored binding once, so the user can try it from the panel.

**Request:** `{ "type": …, "subentry_id": …, "mode_key": …, "action": … }`
**Response:** `{ "success": true }`

## `bilresa_remote/subscribe_events`

Subscription. Streams every normalised remote action so the panel can highlight
the slot that was just pressed — the feature that makes assigning actions
obvious instead of guesswork.

**Request:** `{ "type": "bilresa_remote/subscribe_events" }`

**Events:**

```jsonc
{
  "subentry_id": "01ABC…",
  "ieee": "0x1035970000a197b8",
  "action": "click",
  "mode": 1,
  "mode_key": "1",              // "*" for double/triple when modeless
  "level": 128,                 // wheel only
  "level_pct": 50,
  "direction": "up",
  "has_binding": true,
  "timestamp": "2026-08-08T18:20:00+00:00"
}
```

## Error codes

| Code | Meaning |
|---|---|
| `not_found` | unknown `subentry_id`, or `binding/test` on an empty slot |
| `invalid_format` | malformed request or unknown field |
| `invalid_sequence` | the action sequence failed validation |
| `z2m_unavailable` | Zigbee2MQTT did not answer in time |
| `already_configured` | that IEEE already has a subentry |
| `not_loaded` | the integration has no config entry set up yet |
| `unknown_error` | last-resort catch-all so no handler ever raises |

`z2m_unavailable` is reserved: `discover` and `config` deliberately do **not**
fail with it. They answer with `z2m_available: false` and the last known device
list, so the panel can show the state instead of an error dialog. The frontend
still maps the code, because a future command may use it.

Every code in this table must have a message in `panel/api.js` (`ERROR_MESSAGES`).
