# Operations Guide

This document describes how to run and operate this Admiral fork in production.

## Service Model

Production on this host is managed through:

- `admiral.service`
- `admiral-healthcheck.service`
- `admiral-healthcheck.timer`

Useful commands:

```bash
systemctl status admiral.service --no-pager
systemctl restart admiral.service
journalctl -u admiral.service -n 50 --no-pager
```

The service binary path is:

```text
/root/spacemolt-admiral/admiral/admiral
```

## Build And Restart

Build:

```bash
bun run build
```

Restart:

```bash
systemctl restart admiral.service
```

Do not rely on ad-hoc background starts when the systemd service is the intended control plane.

## Important Paths

- `data/admiral.db`
- `data/memory/`
- `data/spacemolt-kb/`
- `data/spacemolt-kb/manifest.json`
- `data/system-kb-cache.json`
- `/etc/systemd/system/admiral.service`
- `/etc/systemd/system/admiral-healthcheck.service`
- `/etc/systemd/system/admiral-healthcheck.timer`

## KB Mirror

This fork keeps a local mirror of the public SpaceMolt KB published at:

- `https://rsned.github.io/spacemolt-kb/`

Startup behavior:

- Admiral fetches `diffs/index.html` on startup
- if no local KB manifest exists yet, Admiral performs a full initial mirror
- if new diff pages exist, Admiral refreshes only the changed sections
- mirrored content is written under `data/spacemolt-kb/`
- the structured POI helper cache is refreshed separately into `data/system-kb-cache.json`

Operational note:

- KB mirror failures are logged, but they do not intentionally block the main server from starting
- successful syncs log a startup summary with mode, latest diff date, refreshed sections, and local file count

## Recommended Defaults

For most profiles:

- connection mode: `http_v2`
- primary model: your normal budget/default choice
- profile failover: a more available backup model

Use `websocket_v2` only if you specifically want a persistent socket transport and the server path is stable enough.

Operational note:

- `websocket_v2` now goes through the same mutation-metadata normalization path as the HTTP transports
- pending travel/jump state is interpreted consistently across transports when the server exposes enough fields
- pending navigation is cleared not only by `ACTION_RESULT`, but also by `OK jumped` and confirmed `get_status` destination evidence

## Operator UI

The web UI is part of the operating surface, not just a viewer.

Useful dashboard controls:

- live refresh modes: `Off`, `2s`, `5s`
- `Get Status All` for a fast fleet-wide state refresh
- `Nudge All` for a short operator hint to every running agent
- per-profile `Nudge` actions with local input history in the profile view

Operational note:

- the onboarding tour is client-side and can be dismissed per browser via `localStorage`

## LLM Routing Model

This fork has four separate routing layers.

### Primary model

The profile's normal `provider/model`.

### Alternative solver

Controlled through preferences:

- `alt_solver_enabled`
- `alt_solver_provider`
- `alt_solver_model`

Current behavior:

- no fixed round threshold
- only activates on likely loop/stall detection
- examples:
  - repeated identical command rounds
  - repeated blocked error rounds
  - several rounds with unchanged results

If the alternative solver fails, Admiral falls back to the primary model for the same turn.

### Profile failover

Controlled per profile:

- `failover_provider`
- `failover_model`

Current behavior:

- used on rate limits, timeouts, and provider failures
- independent from the alternative solver

### Fleet supervisor

Controlled through preferences:

- `supervisor_enabled`
- `supervisor_provider`
- `supervisor_model`

Current behavior:

- runs on a periodic fleet-wide pass
- reviews active account states plus recent logs
- may inject a short nudge into a running agent
- does not issue game commands itself
- should be used for soft coordination, not destructive recovery

## Free Query Telemetry

This fork reduces wasteful LLM status polling by directly collecting free game queries between turns.

Typical free-query telemetry includes:

- `get_status`
- `get_cargo`
- `view_market`
- `browse_ships`

Operational effect:

- fewer LLM steps burned on routine status checks
- better mining loops
- earlier sell/market awareness
- periodic ship-upgrade awareness when docked

## 429 Prediction

429 prediction is still available, but it is now intended as a UI signal instead of repetitive log noise.

Current behavior:

- elevated 429 risk is attached to profile status data
- the Dashboard summarizes medium/high-risk profiles
- the stats modal lists currently pressured accounts
- routine risk warnings are no longer meant to flood `system` logs

Operationally, this makes the feature usable for triage instead of merely noisy.

## Dashboard Metrics

The web UI now exposes operational and gameplay deltas more clearly.

Current dashboard summary includes:

- `Credits 1h`
- `Ore 1h`
- `Trades 1h`
- current `429 Risk`
- last snapshot time
- live refresh mode state

The stats modal also includes:

- aggregate snapshot/event counts
- `Systems 1h`
- a list of currently risk-elevated profiles

Per-account status panels include richer playstyle indicators when SpaceMolt returns them, such as:

- kills
- completed missions
- non-resource loot onboard

## Google Gemini OAuth

`google-gemini-cli` is supported as an OAuth-backed provider.

Relevant routes:

- `POST /api/oauth/google-gemini-cli/start`
- `GET /api/oauth/google-gemini-cli/status/:sessionId`
- `GET /api/oauth/google-gemini-cli/current`
- `GET /api/oauth/google-gemini-cli/detect-project`
- `POST /api/oauth/google-gemini-cli/manual/:sessionId`

Stored state:

- `preferences.oauth_auth_json`

Operational note:

- a large share of Gemini-related errors will come from the optional compact-input or alternative-solver path if those features are enabled

## Restart Recovery

Restart recovery is built into the server.

On startup:

- `processing` requests are reset to `pending`
- the latest pending request for a profile can be resumed from stored context
- pending `travel`/`jump` state is restored from SQLite via `pending_mutations`

Do not remove the retained request context needed for this path.

## Mutation Stall And Navigation Guarding

This fork now differentiates between:

- normal accepted mutation progress
- local account/session mutation stalls
- broader multi-account server issues

Current behavior:

- duplicate `travel`/`jump` mutations are blocked while prior navigation is still pending
- pending navigation survives process restarts through the `pending_mutations` table
- after several verification cycles without `ACTION_RESULT`, Admiral emits a local-stall signal for that account instead of immediately treating the whole server as frozen
- agents are instructed to describe such cases as local stalls unless multiple accounts independently show matching evidence

Useful diagnostics:

```bash
sqlite3 -header -column data/admiral.db "SELECT * FROM pending_mutations;"
```

```bash
sqlite3 -header -column data/admiral.db "SELECT id, timestamp, profile_id, type, summary FROM log_entries WHERE summary LIKE '%local-stall%' OR summary LIKE '%Mutation stall%' ORDER BY id DESC LIMIT 100;"
```

Manual nudge activity:

```bash
sqlite3 -header -column data/admiral.db "SELECT id, timestamp, profile_id, type, summary FROM log_entries WHERE summary LIKE '%nudge%' ORDER BY id DESC LIMIT 100;"
```

## Fleet Supervisor Operations

The fleet supervisor is optional and configured in Settings.

Use it when you want:

- a separate model to watch for local stall/confusion patterns
- gentle per-account nudges without hard-coding playbooks
- less agent drift into premature `deadlock` or `server freeze` language

Do not use it as:

- a replacement for destructive-command blocking
- a replacement for transport/state correctness fixes
- a second autonomous game actor

## SQLite Retention

Retention is internal. No separate cron job is required.

Current behavior:

- rows older than 3 days are pruned from:
  - `llm_requests`
  - `log_entries`
  - `stats_snapshots`
  - `stats_events`
- successful `llm_requests` keep full request payloads for 3 hours
- after that, successful payloads are compacted
- failed and pending requests keep diagnostic context

Legacy cleanup also removes obsolete preferences such as:

- `display_format`
- `alt_solver_after_rounds`

## Diagnostics

Profiles:

```bash
sqlite3 -header -column data/admiral.db "SELECT id, name, provider, model, failover_provider, failover_model, connection_mode FROM profiles;"
```

Providers:

```bash
sqlite3 -header -column data/admiral.db "SELECT id, status, base_url FROM providers;"
```

Recent logs:

```bash
sqlite3 -header -column data/admiral.db "SELECT id, timestamp, profile_id, type, summary FROM log_entries ORDER BY id DESC LIMIT 100;"
```

Recent request routing:

```bash
sqlite3 -header -column data/admiral.db "SELECT id, profile_id, status, provider_name, model_name, response_model, created_at, completed_at FROM llm_requests ORDER BY id DESC LIMIT 100;"
```

Check OAuth presence:

```bash
sqlite3 -header -column data/admiral.db "SELECT key FROM preferences WHERE key='oauth_auth_json';"
```

## High-Signal Log Messages

When debugging routing behavior, these messages matter:

- `Alternative solver activated after loop/stall detection: ...`
- `Alternative solver failed; reverting to primary model: ...`
- `Switching to profile failover model due to rate limit or provider reachability issue: ...`
- `Using profile failover model (attempt X/3): ...`
- `Primary LLM provider recovered; failover disabled`

Keep the distinction between alternative-solver activation and profile failover. They are not the same event.
