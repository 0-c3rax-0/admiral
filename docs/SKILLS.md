# Agent Guide For This Admiral Fork

This document is for coding agents and operators working inside this repository. It describes how this fork differs from upstream Admiral, how it is configured, and how it should be used safely.

## Scope

Use this guide when working on:

- profile configuration
- LLM provider setup
- failover behavior
- alternative solver behavior
- Google Gemini OAuth
- persistent memory
- connection mode selection
- SQLite retention and diagnostics

## Repository Identity

This repo is a fork of `SpaceMolt/admiral`, with additional runtime and orchestration behavior.

Upstream:

- `https://github.com/SpaceMolt/admiral`

Fork remote in this repo:

- `git@github.com:0-c3rax-0/admiral.git`

Do not assume upstream README or upstream runtime behavior fully matches this fork.

## High-Level Fork Differences

This fork adds important behavior on top of standard Admiral:

- profile-level failover provider/model
- alternative solver after configurable tool rounds
- Google Gemini OAuth via `google-gemini-cli`
- persistent per-profile memory under `data/memory/`
- startup autoconnect with jitter
- runtime stats snapshots/events
- built-in SQLite retention and payload compaction
- `websocket_v2` as a real distinct connection implementation

## Important Runtime Files

- `data/admiral.db`: local SQLite state
- `data/memory/`: persistent profile memory
- `src/server/lib/agent.ts`: agent bootstrap and per-profile loop wiring
- `src/server/lib/loop.ts`: LLM turn loop, failover, alternative solver, compaction
- `src/server/lib/db.ts`: schema, retention, request persistence
- `src/server/routes/oauth.ts`: Google Gemini OAuth flow
- `src/server/lib/connections/websocket_v2.ts`: enhanced WebSocket v2 transport

## How To Run

Development:

```bash
bun install
bun run dev
```

Production build:

```bash
bun run build
./admiral
```

Default app URL:

```text
http://localhost:3031
```

## Provider Configuration Model

Providers are stored in the `providers` table.

Profiles store:

- `provider`
- `model`
- `failover_provider`
- `failover_model`
- `connection_mode`

Provider-level API storage includes:

- `api_key`
- `failover_api_key`
- `base_url`
- `status`

Do not confuse:

- profile failover model selection
- provider failover API key storage
- alternative solver configuration

These are related but separate mechanisms.

## Connection Modes

Supported modes:

- `http`
- `http_v2`
- `websocket`
- `websocket_v2`
- `mcp`
- `mcp_v2`

Preferred default:

- use `http_v2` unless there is a specific reason to prefer another mode

Use `websocket_v2` when you want:

- persistent socket transport
- heartbeat supervision
- reconnect backoff
- re-auth retry on recoverable session/auth failures

Do not describe `websocket_v2` as an alias for `websocket`. In this fork it is implemented separately.

## Alternative Solver Behavior

The alternative solver is configured through preferences:

- `alt_solver_enabled`
- `alt_solver_after_rounds`
- `alt_solver_provider`
- `alt_solver_model`

Current behavior in this fork:

- the primary model handles the first tool rounds
- after the configured round threshold, the active model for the same turn switches to the alternative solver model
- if the alternative solver fails due to rate-limit or reachability style errors, the loop reverts to the primary model
- after that, the normal profile failover path can still activate if needed

Do not describe the alternative solver as "just advisory text". That was an earlier state; this fork now uses it as a real model switch inside the active turn.

## Failover Behavior

Profile failover is distinct from the alternative solver.

Current behavior:

- profile failover activates on provider failures such as `429`, rate limit, timeout, or reachability problems
- when active, the loop uses the profile's configured failover model and failover API key path
- logs distinguish between alternative-solver activation and profile failover activation

Relevant log phrases:

- `Alternative solver activated after ...`
- `Alternative solver failed; reverting to primary model: ...`
- `Switching to profile failover model due to rate limit or provider reachability issue: ...`
- `Using profile failover model (attempt X/3): ...`

When diagnosing runtime behavior, use these exact distinctions.

## Google Gemini OAuth

This fork supports `google-gemini-cli` via local OAuth.

API routes:

- `POST /api/oauth/google-gemini-cli/start`
- `GET /api/oauth/google-gemini-cli/status/:sessionId`
- `GET /api/oauth/google-gemini-cli/current`
- `GET /api/oauth/google-gemini-cli/detect-project`
- `POST /api/oauth/google-gemini-cli/manual/:sessionId`

Stored state:

- OAuth credentials are stored in preferences under `oauth_auth_json`

Usage model:

- Admiral resolves OAuth-backed providers in `src/server/lib/model.ts`
- OAuth credentials are refreshed through `@mariozechner/pi-ai`
- manual re-login is only needed if the refresh path itself fails

Do not assume Google OAuth means "always primary". In this fork it may be used as:

- the profile's primary model
- the alternative solver model

## Persistent Memory

Persistent memory is stored outside SQLite in:

- `data/memory/`

Behavior:

- a profile can load prior memory into new sessions
- memory can be saved and reset via profile routes/UI
- this is separate from `llm_requests.messages_json`

When discussing storage growth, distinguish between:

- SQLite request/log payload growth
- profile memory files on disk

## SQLite Retention

Retention is built into the server process. No external cron or systemd timer is required.

Current retention rules:

- rows older than 3 days are pruned from:
  - `llm_requests`
  - `log_entries`
  - `stats_snapshots`
  - `stats_events`
- successful `llm_requests` keep full `system_prompt` and `messages_json` for 3 hours
- after 3 hours, successful requests have those large fields cleared
- `pending`, `processing`, and `failed` requests keep their full context

This design preserves:

- restart resume behavior
- diagnosis for failed requests
- short-window diagnosis for successful requests

## Restart Recovery

Restart recovery still depends on persisted `llm_requests`.

Current behavior:

- `processing` requests are reset to `pending` on startup
- the latest pending request for a profile can be resumed using stored `system_prompt` and `messages_json`

Do not strip context from `pending` or `processing` requests.

## Operational Guidance

When explaining or modifying this fork, keep these points accurate:

- `http_v2` is the safe default transport
- `websocket_v2` is a real upgraded WebSocket implementation
- alternative solver is a live model switch, not only a suggestion
- failover and alternative solver are different mechanisms
- Google Gemini OAuth can be valid even when no API key is configured
- DB retention exists, but recent heavy traffic can still make `admiral.db` large

## Recommended Diagnostic Queries

Useful checks when debugging local state:

```bash
sqlite3 data/admiral.db '.tables'
sqlite3 -header -column data/admiral.db "SELECT * FROM providers;"
sqlite3 -header -column data/admiral.db "SELECT id, name, provider, model, failover_provider, failover_model FROM profiles;"
sqlite3 -header -column data/admiral.db "SELECT id, timestamp, profile_id, type, summary FROM log_entries ORDER BY id DESC LIMIT 50;"
sqlite3 -header -column data/admiral.db "SELECT id, status, provider_name, model_name, response_model, created_at FROM llm_requests ORDER BY id DESC LIMIT 50;"
```

For Google OAuth diagnostics:

```bash
sqlite3 -header -column data/admiral.db "SELECT key, substr(value,1,300) FROM preferences WHERE key='oauth_auth_json';"
```

## Change Discipline

When changing behavior in this fork:

- update `README.md` if user-visible behavior changes
- keep log wording precise when differentiating alternative solver vs. failover
- preserve restart safety for `pending` and `processing` requests
- avoid changes that silently erase failed-request diagnostics
- use `apply_patch` for repo edits

If behavior is uncertain, inspect the current code before describing it. This fork has already diverged from upstream in meaningful ways.
