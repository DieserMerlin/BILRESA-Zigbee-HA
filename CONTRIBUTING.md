# Contributing

Thanks for wanting to help. This document is short on purpose; the only rule
that really matters is the first one.

## Measurements beat documentation

Almost every non-obvious decision in this integration comes from watching real
MQTT traffic, not from reading a datasheet. Several documented behaviours of the
BILRESA turned out to be wrong (`off_double` is the *triple* click; the lower
button sends nothing; double and triple click carry no `action_group`).

So: if you want to change behaviour that depends on the protocol, please attach
a capture.

```bash
mosquitto_sub -h <broker> -v \
  -t 'zigbee2mqtt/<ieee>' \
  -t 'zigbee2mqtt/bridge/devices' \
  -t 'zigbee2mqtt/bridge/groups'
```

Then run through a scripted sequence — one click, two clicks, three clicks, a
slow turn, the lower button, one click again — and note what you pressed when.
A log without a protocol of what was pressed is hard to use.

If your hardware or your Zigbee2MQTT version disagrees with the table in the
README, say so in an issue. That is a finding, not a mistake.

## Development setup

There is no build step and no runtime dependency beyond Home Assistant itself.

1. Clone the repository.
2. Symlink or copy `custom_components/bilresa_remote` into the
   `custom_components` directory of a development Home Assistant instance.
3. Restart, add the integration, and turn on debug logging:

   ```yaml
   logger:
     default: warning
     logs:
       custom_components.bilresa_remote: debug
   ```

Every raw payload is logged at debug level, which is usually all you need.

## Code style

- Python 3.12+, `from __future__ import annotations`, full type annotations.
- English docstrings on every module, class and public function.
- Comments explain *why*, not *what*. If the code needs a comment to say what it
  does, rewrite the code instead.
- Async everywhere. No blocking I/O in the event loop.
- Modern Home Assistant patterns: `entry.runtime_data`,
  `async_forward_entry_setups`, config subentries, `async_on_unload`.
- Nothing on the MQTT hot path may raise or await.

Formatting and linting:

```bash
pip install ruff
ruff check --line-length 100 .
ruff format --line-length 100 .
```

CI runs exactly these two commands, plus `hassfest` and the HACS validation.

## Constants are a contract

`custom_components/bilresa_remote/const.py` is the shared contract between the
modules. Renaming something there means touching every module that imports it,
so add rather than rename, and keep the protocol facts documented next to the
constant they describe.

## Pull requests

- One topic per pull request.
- Describe what you measured or reproduced, not only what you changed.
- Do not bump the version in `manifest.json`; the release workflow writes it
  from the git tag.
- New user-facing strings need an entry in `translations/en.json`. German is
  maintained as well; other languages are welcome but not required.

## Releasing (maintainers)

1. Make sure `main` is green.
2. Create a GitHub release with a tag like `v0.2.0`.
3. The release workflow writes the version into `manifest.json` and attaches
   `bilresa_remote.zip`, containing the *contents* of the component directory,
   which is what HACS expects with `zip_release`.

## Code of conduct

Be decent. Assume the other person is trying to help. That is the whole policy.
