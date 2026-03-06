# Operations Guide

This document describes how to run, configure, and diagnose this Admiral fork in day-to-day operation.

## What This Fork Changes Operationally

Compared with upstream Admiral, this fork adds runtime behavior that matters in operations:

- profile-level LLM failover
- alternative solver switching after configurable tool rounds
- Google Gemini OAuth support
- persistent profile memory on disk
- startup autoconnect with randomized delay windows
- built-in SQLite retention and successful-request payload compaction
- enhanced `websocket_v2` transport

## Run Modes

Development:

```bash
bun install
bun run dev
```

Production:

```bash
bun run build
./admiral
```

Default URL:

```text
http://localhost:3031
```

Important local data paths:

- `data/admiral.db`
- `data/memory/`

## Recommended Default Configuration

For most profiles:

- connection mode: `http_v2`
- primary provider/model: your preferred stable model
- failover provider/model: a cheaper or more available backup model

Use `websocket_v2` only when you explicitly want persistent socket transport and the server path is stable enough for it.

## LLM Control Model

This fork has three separate LLM-routing mechanisms:

### 1. Primary model

The profile's normal `provider/model`.

### 2. Alternative solver

Configured through preferences:

- `alt_solver_enabled`
- `alt_solver_after_rounds`
- `alt_solver_provider`
- `alt_solver_model`

Behavior:

- after the configured tool-round threshold, the active turn can switch to the alternative solver model
- if that model fails, the loop reverts to the primary model

### 3. Profile failover

Configured per profile:

- `failover_provider`
- `failover_model`

Behavior:

- activates on provider failures such as `429`, reachability errors, or similar retry/failover conditions
- can still activate even after an alternative solver was tried

## Google Gemini OAuth

This fork supports `google-gemini-cli` as an OAuth-backed provider.

Operational notes:

- OAuth state is stored locally in SQLite preferences under `oauth_auth_json`
- access tokens may expire, but refresh is handled through the provider library
- manual re-login is only required if refresh itself fails or credentials are revoked

Relevant backend routes:

- `POST /api/oauth/google-gemini-cli/start`
- `GET /api/oauth/google-gemini-cli/status/:sessionId`
- `GET /api/oauth/google-gemini-cli/current`
- `GET /api/oauth/google-gemini-cli/detect-project`
- `POST /api/oauth/google-gemini-cli/manual/:sessionId`

## Restart Behavior

This fork preserves restart recovery for active work.

On startup:

- `processing` LLM requests are moved back to `pending`
- the latest pending request for a profile can be resumed from stored request context

This depends on keeping full context for:

- `pending`
- `processing`

Do not introduce retention changes that strip those rows.

## SQLite Retention

Retention is internal to the app. No external scheduler is required.

Current behavior:

- rows older than 3 days are pruned from:
  - `llm_requests`
  - `log_entries`
  - `stats_snapshots`
  - `stats_events`
- successful `llm_requests` keep full `system_prompt` and `messages_json` for 3 hours
- after 3 hours, successful requests are compacted by clearing those heavy fields
- failed requests keep their context for diagnosis

What this means operationally:

- DB growth is reduced, but not eliminated
- heavy traffic within a short window can still make `admiral.db` large
- retention helps most with historical buildup, not burst load

## Persistent Memory

Profile memory is stored outside SQLite:

- `data/memory/`

This is intentionally separate from transient turn/request payloads.

Use it for:

- long-running role memory
- task continuity across restarts
- operator-curated agent memory

Do not confuse persistent memory with request replay context.

## Connection Modes

Supported:

- `http`
- `http_v2`
- `websocket`
- `websocket_v2`
- `mcp`
- `mcp_v2`

Operational guidance:

- `http_v2`: safest default
- `websocket_v2`: lower-latency persistent socket mode with heartbeat/reconnect/reauth handling
- `mcp_v2`: use when you explicitly want tool-discovery-oriented MCP v2 behavior

## High-Signal Logs

When diagnosing model routing, these phrases matter:

- `Alternative solver activated after ...`
- `Alternative solver failed; reverting to primary model: ...`
- `Switching to profile failover model due to rate limit or provider reachability issue: ...`
- `Using profile failover model (attempt X/3): ...`
- `Primary LLM provider recovered; failover disabled`

Do not collapse these into a single generic “failover happened” explanation.

## Useful Local Diagnostics

Providers:

```bash
sqlite3 -header -column data/admiral.db "SELECT * FROM providers;"
```

Profiles:

```bash
sqlite3 -header -column data/admiral.db "SELECT id, name, provider, model, failover_provider, failover_model, connection_mode FROM profiles;"
```

Recent logs:

```bash
sqlite3 -header -column data/admiral.db "SELECT id, timestamp, profile_id, type, summary FROM log_entries ORDER BY id DESC LIMIT 100;"
```

Recent LLM requests:

```bash
sqlite3 -header -column data/admiral.db "SELECT id, profile_id, status, provider_name, model_name, response_model, created_at, completed_at FROM llm_requests ORDER BY id DESC LIMIT 100;"
```

Check Google OAuth presence:

```bash
sqlite3 -header -column data/admiral.db "SELECT key FROM preferences WHERE key='oauth_auth_json';"
```

## Safe Change Rules

When changing this fork in production-sensitive areas:

- preserve restart recovery for `pending` and `processing` requests
- preserve failed-request diagnostic value unless intentionally changing retention policy
- update `README.md` when user-visible runtime behavior changes
- keep logs precise enough to distinguish alternative solver, primary model, and profile failover
