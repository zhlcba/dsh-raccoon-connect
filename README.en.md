# DSH Raccoon Connect

[中文](./README.md) | English

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH kernel](https://img.shields.io/badge/DSH-0.2.1--rc.1%20~%200.2.x-2f6f4f.svg)](#install-and-version-mapping)
[![tests](https://img.shields.io/badge/tests-176%20passing-4b6fff.svg)](./CHANGELOG.md)
[![npm](https://img.shields.io/npm/v/dsh-raccoon-connect?color=cb3837)](https://www.npmjs.com/package/dsh-raccoon-connect)

> **Mirror for users in China**: [Gitee · dhzl/dsh-raccoon-connect](https://gitee.com/dhzl/dsh-raccoon-connect) — use this when GitHub is hard to reach; content is kept in sync.

Bring the models bundled in the **SenseTime 小浣熊** (XiaoHuanXiong) desktop app — GLM-5.3, GLM-5.3-Flash, Kimi-K3, SenseNova-6.8-Flash-Lite, DeepSeek-V4.1-Flash and whatever else your account is served — into DeepSeek Harness. Pick them in the model selector and talk: **no API key to paste.** The plugin reuses the desktop app's stored sign-in and follows account switches automatically.

> ### This is a fork: it adds DSH 0.2.x support
>
> The upstream [liudapeng0311/dsh-raccoon-work](https://github.com/liudapeng0311/dsh-raccoon-work) declares support for `0.1.5-rc.1` only. On a DSH 0.2.x kernel the compatibility check **rejects it outright** — it cannot be installed. This fork adds the 0.2.x adaptation and has been verified on Windows + Desktop profile + `0.2.1-rc.2` (model group appears, chat works).
>
> **Nothing but the kernel adaptation was changed** — upstream protocol, token semantics, rate arithmetic, vision verdicts and probe logic are untouched. All 176 upstream tests pass. See [CHANGELOG.md](./CHANGELOG.md) for the itemised diff.
>
> The plugin skeleton follows [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT). The upstream protocol, token semantics, rate arithmetic and probe verdicts were rewritten against the **measured** behaviour of the 小浣熊 gateway; see `docs/upstream-protocol.md`.

## Quick start

Requirement: the 小浣熊 desktop app installed **and signed in**. The plugin does not launch it and does not log in on your behalf.

```sh
# 1) Install (Desktop profile; use `web` on a Web profile)
dsh plugin --profile desktop add dsh-raccoon-connect
# or straight from GitHub:
# dsh plugin --profile desktop add github:zhlcba/dsh-raccoon-connect

# 2) Fully quit DSH (tray included) and start it again

# 3) Pick a model from the 商汤小浣熊 group and talk
```

No second sign-in: the plugin reads the credential file the desktop app already writes for its local agent.

## FAQ

**Does the desktop app have to stay running?**
No. The plugin reads a credential **file** (`~/.box-agent/config/auth.json`), not a live process. As long as the app has signed in once and the credential is still valid, it works with the app closed. You only need the app for: first sign-in, a revoked/expired credential, or an account switch.

**Which DSH versions are supported?**
This fork supports `0.2.1-rc.1` – `0.2.x` (verified on `0.2.1-rc.2`). For upstream's 0.1.x line use the [upstream repo](https://github.com/liudapeng0311/dsh-raccoon-work). Installing the wrong generation is refused by DSH's compatibility check — that is a guard, not a bug.

**Will it spend my credit?**
Yes — your own 小浣熊 account's credit. The plugin only forwards requests locally; it does not proxy, does not upload your data, and credentials never leave the machine. Respect SenseTime's terms of service; see the disclaimer at the end.

**No model group after installing?**
Check in order: ① has the desktop app ever signed in (`~/.box-agent/config/auth.json` present)? ② did DSH fully restart? ③ run `dsh plugin --profile desktop exec dsh-raccoon-connect doctor`.

## Features

- **Works out of the box.** Install, enable, pick a model, talk. No API key to paste: the plugin reuses the sign-in the desktop app already stores for its own local agent, and follows account switches automatically.

- **Rates and promotions in the picker.** Each model name carries the billing multiplier and promotion label from the upstream catalog, e.g. `GLM-5-3-Flash · x0.10 · 限时折扣`, `SenseNova-6.8-Flash-Lite · x0.00 · 限免一个月`. Display only — nothing about the request changes. Promotional windows are re-derived over time: once a window closes the list price returns, and if no list price was ever published the rate shows as *unknown* rather than keeping a stale discount.

- **Image input** is decided per model by measurement, not by the catalog's `vision` tag. That tag is the only capability signal the upstream publishes, and on 2026-09-18 it proved wrong on two of the five visible rows, in both directions: `DeepSeek-V4.1-Flash` and `GLM-5-3-Flash` carry no tag yet do read images, while `GLM-5-3` is tagged and has the image silently dropped by the gateway (the model replies "I cannot see this image", which is harder to notice than a refusal). So images are offered for SenseNova-6.8-Flash-Lite, Kimi-K3, GLM-5-3-Flash and DeepSeek-V4.1-Flash, and GLM-5-3 is described as text-only — DSH never puts an image in front of it. If a newly listed model is mis-tagged, correct it with the `visionModelIds` / `textOnlyModelIds` plugin settings instead of waiting for a release; see *Re-verifying against the real gateway* for re-running the measurement.

- **Thinking output.** The gateway streams reasoning in a non-standard `delta.reasoning_content` field; it is passed through unchanged, so the harness renders it as a reasoning stream.

- **Status and refresh.** Settings → Plugins → 商汤小浣熊 shows the account, identity (personal/organization), token expiry, remaining credit, and whether the roster on screen is live, restored-from-disk, or the built-in fallback — plus the reason the last fetch failed, and a manual refresh.

- **Reasoning-effort detection** exists in the card and the composer, and deliberately makes no guesses (see below for why it usually reports *not validating*).

## Install and version mapping

Requirement: the 小浣熊 desktop app installed and signed in. The plugin does not launch it and does not log in on your behalf.

```sh
# ① npm (recommended)
dsh plugin --profile desktop add dsh-raccoon-connect

# ② From GitHub (lib/ is committed, so this works as-is)
dsh plugin --profile desktop add github:zhlcba/dsh-raccoon-connect

# ③ From a local checkout (development)
dsh plugin --profile desktop add link:/path/to/dsh-raccoon-connect
```

Then **fully quit DSH (tray included) and start it again**, and look for the 商汤小浣熊 group in the model selector.

**Version coupling**: the plugin must match the DSH core generation; mixing them fails the DSH boot.

| Plugin | Required DSH core | Node | Verified |
|---|---|---|---|
| `0.2.x` (this fork) | `>=0.2.1-rc.1 <0.3` | `^22.19.0 \|\| >=24.0.0` | Windows + Desktop, `0.2.1-rc.2` ✅ |
| `0.1.x` (upstream) | `0.1.5-rc.1` | same | upstream verified Web profile only |

Verification scope of this fork: Windows, Desktop profile, DSH `0.2.1-rc.2` — the plugin registers
(`$DSH_HOME/.raccoon-host-heartbeat.json`), the model group appears in the picker, and selected models
send and receive. The settings card is contributed through a runtime bridge (the new kernel's render slot
union does not include it); whether the card renders was not verified item by item, and its absence does
not affect the model channel. `dsh.client.platform` is still declared as `web`.

## Configuration

The card has no editor for these fields; they live in the profile's patch layer, `~/.dsh/profiles/web/cordis.patch.yml`, as a `config` block targeting the `llm-raccoon` entry (restart DSH afterwards):

```yaml
- id: llm-raccoon
  config:
    # authFile: 'C:/Users/you/.box-agent/config/auth.json'   # defaults to ~/.box-agent/config/auth.json — never set it to an empty string
    # probeConsent: true      # standing authorization for effort detection; off by default since each run spends credit
    visionModelIds: []      # ids to offer with image input, whatever the tag says
    textOnlyModelIds: []    # ids to keep text-only; wins over the list above
```

The two lists exist for a mis-tagged upstream row (see *Image input* above): a newly listed model that reads images can be enabled without waiting for a release, and the reverse works the same way.

## How the credential is reused — and one side effect you should know about

The desktop app keeps its sign-in in `~/.box-agent/config/auth.json` (relocatable with `BOX_AGENT_CONFIG_DIR`). Access tokens last 3 hours, refresh tokens 30 days, and its refresh endpoint is **single-use**: one refresh rotates the access *and* the refresh token together.

So the credential policy differs from a read-only reuse design:

- Token still valid: read and use it. No refresh, no network call.
- Token inside the renewal margin: refresh once and **write the rotated pair back into the app's own `auth.json`**. This is not optional — without the write-back, the app's next refresh hits `refresh_conflict` and you are signed out of 小浣熊. The rewrite keeps the app's format and its atomic write (temp file plus rename) and preserves fields the plugin does not own. Before the first rewrite in a process, a backup of the replaced file is left under `$DSH_HOME` as rollback material.
- `refresh_conflict`: re-read the app file first (the app probably just refreshed), continue if it holds a live token; otherwise report "open 小浣熊 once to sign in again".
- `logout` deletes only the plugin's own copy and backup. The app's login file is never touched.

With no usable sign-in, the model group disappears entirely rather than listing models that must fail.

## Why effort detection usually answers "not validating"

The gateway validates `reasoning_effort` only *partly*. Measured on `sn-glm-5-3-flash` with minimal requests:

| Sent value | Gateway |
|---|---|
| `off`, `banana` | 400 — `该模型始终思考，不支持关闭思考；请使用 low、high 或 max。` |
| `low` / `medium` / `high` / `xhigh` / `max` | 200 |
| garbage (`randomword1234567890`), sentinel value | **also 200** |

A 200 therefore proves nothing about whether a level was honored — nonsense returns 200 too. The sweep tests this first by sending a value that cannot exist; the 小浣熊 gateway accepts it, so the run is reported `non-validating` and **no effort dropdown is offered**. That is the correct verdict, not a failure: no control beats five controls that look real and are ignored. The 400 text does name the accepted vocabulary, but it is prose for humans rather than a structured field, so the plugin does not parse it.

## Why effort detection needs a click here and not there

WorkBuddy's upstream **declares** reasoning capability in structured form per model (`reasoning.supports`, `supportedEfforts[]`, `canDisableThinking`), so its picker is filled from the catalog without a single extra request; probing is only its fallback for rows that declare nothing. 小浣熊 has no such field — a catalog row carries `name / description / display_description / visible / model_name / tags / ability_level / params / billing_*` and never mentions effort, and the app itself never sends `reasoning_effort`. Levels can therefore only be established by experiment, an experiment costs credit, and so its result is cached: keyed by **account plus a fingerprint of the catalog row** (id, capability tags, context window, output ceiling) in `~/.dsh/.raccoon-probe.json`, valid for 14 days, invalidated automatically when the upstream changes that row.

A cache is only useful if it survives a restart, and before 0.1.2 it did not: the first time the plugin recognized the account after boot it took the "account changed" branch and cleared the whole probe store — destroying observations that same account had paid for, which is why the detection had to be re-run after every restart. That branch no longer clears anything; cross-account safety was already per record (a stored observation whose account does not match the current one is treated as absent), so the dropdown is now available straight after a restart.

## Command line

```sh
dsh plugin --profile web exec dsh-raccoon-connect status   # sign-in, token expiry, remaining credit (--json for machines)
dsh plugin --profile web exec dsh-raccoon-connect doctor   # paths, heartbeat, client identity, fallback roster
dsh plugin --profile web exec dsh-raccoon-connect logout   # removes only the plugin's own copy and backup
```

`status` and `doctor` never refresh a token: rotation has write side effects, and a command typed to look at state should not change your sign-in.

## Re-verifying against the real gateway

After an app update, re-run the protocol against the live gateway (costs a trivial amount of credit):

```sh
npm run build
node tools/live-check.mjs          # catalog, balance, one minimal completion
node tools/live-stream-check.mjs   # full harness path: pi-ai → loopback shim → upstream, including tool calls
node tools/vision-check.mjs        # per-model image-input measurement (self-verifying stripes)
```

`vision-check.mjs` prints one line per visible model with the catalog tag, the shipped measurement, and this run's verdict, flagging `≠tag` where they disagree. Re-run it after an app update or when the upstream lists a new model, and record the outcome in `MEASURED_VISION` (`src/catalog.ts`).

Findings and the verdicts they force are recorded in `docs/upstream-protocol.md`.

## Known limitations

- Depends on the desktop client's private interfaces, not an official open API; an app update may require changes. The credential file's field names and the refresh semantics are the two most likely to move.
- Verified on Windows only. The credential path resolves through `os.homedir()` plus `BOX_AGENT_CONFIG_DIR`, so macOS/Linux follow the same logic untested; point `RACCOON_AUTH_FILE` at the real file if that does not match.
- `params.context_window` / `max_tokens` from the catalog are the only basis; models without them fall back to a conservative envelope rather than an invented-large window.
- Personal accounts send an empty `X-Org-Code`; organization accounts are unverified.

## Disclaimer

- For personal study and research only. It drives the operator's own 小浣熊 account on their own machine; do not use commercially or beyond reasonable personal use.
- You are responsible for complying with 小浣熊's terms of service. Any consequence of using this project — including account restriction, quota wipe, service interruption, or a login state overwritten by token refresh — is yours to bear.
- The authors accept no liability for direct or indirect loss caused by using or misusing this project.
- This project is unaffiliated with SenseTime, 小浣熊 and DeepSeek, is not authorized or endorsed by them, and uses their names only to describe compatibility.

## Credits

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT) — reference for the DSH provider-plugin structure, the loopback shim and the probe paradigm.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) — reference for provider registration.

## License

[MIT](./LICENSE)
