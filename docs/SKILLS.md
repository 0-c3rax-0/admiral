# Agent Guide

This document is for coding agents and operators working inside this repository.

## Repository Identity

This repo is a fork of `SpaceMolt/admiral` with additional orchestration and operations behavior.

Upstream:

- `https://github.com/SpaceMolt/admiral`

Do not assume upstream README text or upstream runtime behavior matches this fork.

## Runtime Differences From Upstream

This fork adds or changes:

- profile-level primary and failover provider/model routing
- alternative solver activation only on detected loops or stalled plans
- manual per-profile and fleet-wide nudge delivery from the UI
- Google Gemini OAuth via `google-gemini-cli`
- persistent per-profile memory under `data/memory/`
- startup autoconnect with jitter
- runtime stats snapshots and events in SQLite
- built-in SQLite retention and request payload compaction
- free-query telemetry injection for better mining/trading loops
- UI-visible 429 risk summaries
- broader account status cards with combat/mission/loot indicators
- `websocket_v2` as a real separate implementation

## Files That Matter

- `src/server/lib/agent.ts`
- `src/server/lib/loop.ts`
- `src/server/lib/db.ts`
- `src/server/lib/model.ts`
- `src/server/routes/oauth.ts`
- `src/frontend/src/components/ProviderSetup.tsx`
- `data/admiral.db`
- `data/memory/`

## Alternative Solver

Configuration:

- `alt_solver_enabled`
- `alt_solver_provider`
- `alt_solver_model`

Current behavior:

- not based on a fixed tool-round threshold anymore
- activates only when Admiral detects likely looping or stalling
- loop signals include repeated identical command rounds, repeated blocked error rounds, or unchanged results across multiple rounds
- if it fails, the turn returns to the primary model

Do not describe the alternative solver as a generic “advisor after N rounds”. That is no longer accurate.

## Profile Failover

Profile failover is separate from the alternative solver.

Configuration:

- `failover_provider`
- `failover_model`

Current behavior:

- used on rate limits, timeouts, or similar provider failures
- still available even if the alternative solver exists

When writing docs or incident notes, distinguish:

- alternative solver activation
- profile failover activation

## Free Query Telemetry

This fork now injects compact telemetry from free game queries between turns.

Common queries:

- `get_status`
- `get_cargo`
- `view_market`
- `shipyard_showroom`
- `browse_ships`

Intent:

- reduce wasteful LLM status polling
- improve mining loops
- avoid cargo hoarding without market checks
- notice practical ship upgrades when docked

## UI Metrics

This fork intentionally pushes more information into the web UI instead of leaving it buried in logs.

Examples:

- profile-level 429 risk in dashboard status data
- dashboard 1-hour deltas for credits, ore, and trades
- dashboard live refresh controls plus `Get Status All` / `Nudge All`
- per-account status cards with kills, completed missions, and non-resource loot onboard

Important distinction:

- ore, gas, and ice remain part of normal cargo/mining displays
- the `Loot` indicator is intentionally meant for non-resource cargo only

## Google Gemini OAuth

This fork supports `google-gemini-cli` via local OAuth.

Routes:

- `POST /api/oauth/google-gemini-cli/start`
- `GET /api/oauth/google-gemini-cli/status/:sessionId`
- `GET /api/oauth/google-gemini-cli/current`
- `GET /api/oauth/google-gemini-cli/detect-project`
- `POST /api/oauth/google-gemini-cli/manual/:sessionId`

Stored credentials:

- `preferences.oauth_auth_json`

Do not assume Gemini is always the primary model. In this fork it may be:

- a primary model
- the compact-input model
- the alternative solver model

## Retention

Retention is enforced in the server process.

Current behavior:

- 3-day pruning for:
  - `llm_requests`
  - `log_entries`
  - `stats_snapshots`
  - `stats_events`
- 3-hour retention of full successful request payloads
- later payload compaction for successful requests
- failed and pending requests retain diagnostic context

Legacy preference cleanup includes:

- `display_format`
- `alt_solver_after_rounds`

## Operational Assumptions

Preferred production control plane:

- `systemctl restart admiral.service`
- `systemctl status admiral.service --no-pager`
- `journalctl -u admiral.service -n 50 --no-pager`

Do not treat manual background starts as the normal production workflow when the systemd service exists.

## UI Notes

Current frontend behavior that matters when documenting or operating the repo:

- the onboarding tour auto-opens only for browsers that have not set `admiral-tour-seen`
- per-profile nudge inputs keep local history in browser storage
- dashboard fleet actions and profile nudge actions both feed the same server-side nudge path

## Safe Guidance

When changing code or docs in this repo:

- verify current behavior in code before describing it
- do not document the alternative solver as round-count based
- do not claim query commands are “free” in the LLM sense; they are free on the game side, but may still cost LLM turns if routed through model planning
- keep the distinction between free direct telemetry and LLM-planned tool calls
