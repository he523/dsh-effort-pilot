# dsh-effort-pilot

A DSH host plugin that schedules `reasoningEffort` per request from **observed
difficulty**, instead of guessing from how cheap a tool call looks.

Replaces `dsh-thinking-levels`, whose tool heuristic never executed on rc.2 (it
read `agent.session.events`, which does not exist) and therefore downgraded
**every** request to `low`. See `DESIGN-dsh-effort-pilot.md` in
`~/Documents/deepseek-harness/default-workspace/dsh-effort-research/`.

## How it decides

Four layers, cheapest first:

| Layer | Signal | Cost |
|---|---|---|
| **L1 local** | retry chains, tool failures, repeated targets, payload growth *trend*, tool diversity, context pressure, first-turn flag, `llm/retry` events | free, every turn |
| **L2 semantic** | a cheap model rates the user request 0-10 | sampled only |
| **L3 hysteresis** | dead zone + N-round confirmation + min dwell | free |
| **L4 guard** | unsupported levels are lifted or stripped, never sent | free |

Design rules that differ from the predecessor:

- **Tool names are never a difficulty input.** `read` may mean 5 lines or 5,000.
- **A first turn never downgrades.** Absence of information is not evidence of
  simplicity — and layer L2 is always consulted there, because that is the
  planning turn and the one the predecessor got wrong.
- **`max` is reachable by default** (`allowUpgrade: true`).
- **A manual pick is respected** — but an unadvertised one is stripped rather
  than forwarded, because the provider would reject the request.

## Cost and privacy

L2 is the only outbound request. It sends a truncated copy of the user's latest
message to the configured provider (default `zhipu` / `glm-4-flash`) and expects
one integer back. Containment:

- per-turn cap 1 (guards against waterfall re-entry), per-session cap 20
- result cache keyed by message + route, so a repeated message is never billed twice
- 2500 ms deadline on its own `AbortSignal`, decoupled from the user request
- any failure — timeout, transport throw, `error`/`aborted` finish reason,
  unparseable text — degrades to the L1 score and never blocks the request

Set `mode: local` to make **zero** outbound requests (L1 only).

### Model choice is measured, not guessed

`tools/probe-route.mjs` sweeps models and token budgets against the real
endpoint. Result on this machine:

| model | reasoning tokens | completion tokens | latency | verdict |
|---|---|---|---|---|
| `glm-4-flash` | 0 | 3–8 | ~0.7 s | **default** — answers immediately |
| `glm-4.5-flash` | 220–280 | 220–280 | ~5 s | unusable under a 2.5 s deadline |
| `glm-4.5-air` | 130–250 | 130–250 | ~4.5 s | same problem |

The GLM 4.5 family are **reasoning** models: they fill `reasoning_content`
before emitting any `content`. With the original `maxTokens: 8` they spent the
entire budget thinking, returned an **empty** answer with
`finish_reason: "length"`, and the score was unusable 100% of the time. The
budget is now 64 tokens and the default route is the non-reasoning model.

If you switch to a 4.5-class model, raise `timeoutMs` to at least 8000 — L2 would
otherwise time out and silently degrade to L1.

## Configuration

Runtime (`.volatile()` — edits apply to the next request, no restart), via the
plugin settings card or a profile patch with the same id:

```yaml
- id: effort-pilot
  config:
    enabled: true
    mode: hybrid            # local | hybrid
    lowMax: 3               # difficulty below this schedules low
    highMin: 6              # difficulty above this schedules max
    confirmRounds: 2        # consecutive observations before a switch
    minDwellTurns: 1        # turns to hold after a switch
    allowDowngrade: true
    allowUpgrade: true      # false caps the scheduler at high
    respectManual: true
    advertiseAuto: true     # offer Auto in the model selector
    weights:                # relative signal weights
      retryRatio: 3.0
      errorRatio: 3.0
      rereadRatio: 2.0
      payloadTrend: 1.5
      toolDiversity: 1.0
      contextPressure: 1.0
    semantic:
      enabled: true
      provider: zhipu
      model: glm-4-flash
      timeoutMs: 2500
      maxInputChars: 2000
      ambiguousLow: 3       # outside this band the local score decides alone
      ambiguousHigh: 6
      resampleTurns: 10
      maxCallsPerTurn: 1
      maxCallsPerSession: 20
      alwaysOnFirstTurn: true
```

Every key is optional; the schema defaults are the values above.

## Observability

One structured line per request:

```
[effort-pilot] turn=3 model=deepseek-account/deepseek-flash calls=5
  retry=0.2 err=0 reread=0.25 trend=0.5 div=0.8 ctx=0.31
  local=4.2 semantic=7(ambiguous-band) difficulty=5.6 first=false
  from=auto => level=high (confirm-pending)
```

`reason` values: `hold`, `switch`, `confirm-pending`, `min-dwell`,
`first-turn-no-downgrade`.

### The decision journal

**DSH keeps no runtime log file** — `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`
holds only `crash-*-host.log`, so the line above reaches stdout and is lost. The
plugin therefore also appends it to:

```
$DSH_HOME/effort-pilot.log        (usually ~/.dsh/effort-pilot.log)
```

One line per decision, ISO timestamped, rotated to `.log.1` at 1 MB. Writes are
synchronous, so a line is on disk before the request proceeds and survives an
abrupt exit; a write failure disables the journal rather than affecting the
request. Set `journal: false` to turn it off.

This file is the only way to review what the scheduler did after the fact — keep
it in mind when tuning thresholds.

## Showing the level: the UI chip

`Auto` is otherwise invisible — the selector says "auto" and the chosen level
never surfaces. The plugin therefore renders a small chip in the composer tool
row, beside the controls before the submit button.

```
plugin decision ──► $DSH_HOME/.dsh-effort-state.json
                                │
                host route  GET /dsh-effort/state.json
                                │
                CLIENT half (slot) ──► conversation.input.right
                                │
                          ◆ 低     ← the chip
```

It shows just the level (`低` / `高` / `最大`) with a small coloured dot; the
`title` tooltip carries the detail (difficulty, verdict, reason).

**Styling.** Deliberately a **text label, not a pill**: no surface, no border,
theme `label-secondary` for the text, and only the 6px dot carries the level
colour. The controls beside it are ghost buttons with no background, so a filled
pill read as a foreign element.

### The chip is a client plugin, not an injected script

The plugin has two halves, and they are two halves on purpose — the host runs in
Node and cannot render, the client runs in the browser and cannot read the
session or call the model:

| Half | File | Runs in | Does |
|---|---|---|---|
| Host | `lib/index.js`, `lib/chip-server.js`, `lib/publish-state.js` | Node | schedules the level, publishes it, serves the route |
| Client | `lib/client.js` | browser | registers the chip into a slot and renders it |

The client half is wired through `dsh.client` + `exports["./client"]`, and follows
the lazy-CJS contract the web app's module loader expects:

```js
window.__ModuleLoader__.load({
  id: "dsh-effort-pilot",
  factory: (require) => { /* require("react"); … */ },
});
```

**No build step.** The factory requires only `react` from the host's shared client
module table, so the file stays self-contained — no relative requires, no JSX, no
bundler. This was verified against installed plugins before being relied on.

**Why a slot instead of injecting a `<script>`.** An earlier design pushed an
inline script row into `webserver/index-inject` and then **anchored the chip by
searching the composer DOM**. It broke twice, silently, in one session layout but
not another — and each time had to be re-diagnosed by shipping instrumented probes
into the page, because the host cannot see the page's DOM. The Slot API removes
that whole class of failure: **the slot owner decides placement**, so no plugin
code has to guess at markup and a layout change cannot strand the chip.

The old approach's constraints are recorded here in case the injection channel is
ever needed again:

- The desktop shell renders `index.html` from its install directory, so
  `webServer.tapIndex` never runs there.
- `webserver/index-inject` is collected **once** at host startup, so a row
  registered after a service wait is lost **with no error**.
- A row must be an inline `script` row, **never `script-src`** — the page
  interpreter awaits `script-src` loads and a failure there rejects boot.

`chip: false` disables all of it — no state written, no routes, no chip.

### Runtime diagnostics

The client half can fail silently just as the script could: a bundle that does not
resolve, or a slot that is not present, renders nothing and reports nothing. The
host exposes its counters at `/dsh-effort/status.json` (loopback only):

| Field | Tells you |
|---|---|
| `reports` + `lastReport.at` | whether the client half ran, and where it rendered |
| `routeHits` | whether each route is actually being requested |

The guard keys off `req.socket.remoteAddress`, **never the `Host` header** — the
header is client-supplied, and the host can bind `0.0.0.0`.

### No third-party plugin is touched

This deliberately replaced an even earlier design that patched
[dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget).
That approach worked but had two costs: the widget's files were modified, and any
widget upgrade discarded the patch. The chip owns its own route and its own state
file, so **nothing external can break it and it cannot break anything**.

## Install and iterate

The plugin is a `file:` dependency of the profile, so pnpm **hard-links** it into
`node_modules`. An editor that writes via rename breaks that link and leaves the
installed copy stale, which is why edits go through the sync tool:

```powershell
cd ~/.dsh/local-plugins/dsh-effort-pilot
node --test "tests/*.test.js"          # 74 unit tests, no host needed
node tools/sync.mjs                    # make the installed copy match
node tools/sync.mjs --check            # report staleness only
node <profile>/node_modules/dsh-effort-pilot/tools/verify.mjs   # loader contract
node tools/probe-route.mjs             # re-measure the scoring route
node tools/measure-latency.mjs 20      # failure rate + latency percentiles
node tools/score-sample.mjs            # verdict quality on real messages
```

### Reading real sessions

```powershell
node tools/decode-session.mjs <session.v4.jsonl.zstd> out.jsonl   # mixed container
node tools/validate-real-session.mjs out.jsonl                    # replay the signal layer
node tools/effort-timeline.mjs out.jsonl                          # when did the level move
node tools/live-check.mjs out.jsonl                               # what fired, what did not
```

The session log is a **mixed container**: an uncompressed `{"type":"session",…}`
header line followed by one zstd frame per flush (963 in a 1.3 MB log). No single
decompressor reads it, which is why `decode-session.mjs` cuts at each frame magic.

`tools/verify.mjs` resolves the plugin through the profile (so
`@deepseek-ai/schemastery` resolves exactly as it will at runtime) and exercises
the bundle manifest, the loader contract and the request waterfall with a fake
host. Run it before restarting: it catches failure modes that are otherwise
invisible until the GUI simply does not show the plugin.

### The one field that is easy to forget

`package.json` **must** declare where the bundle patch lives:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Without it the loader has no patch to apply, the plugin contributes **no row at
all**, and nothing anywhere reports an error — the plugin is simply absent from
the tree. `verify.mjs` now asserts this against the installed manifest, because
that is exactly how the first install failed.

**Bundle changes need a full app restart** — a running instance does not
hot-load new bundle layers. `.volatile()` config edits do not.

## Rollback

```powershell
# disable without uninstalling
plugin_manager -> set_plugin(target: "dsh-effort-pilot", enabled: false)
```

or set `enabled: false` in the config patch. The row can also be removed from the
profile's `package.json` `dsh.profile.bundles` and `dependencies`.
