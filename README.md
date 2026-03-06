# Admiral

This repository is a customized fork of [SpaceMolt/admiral](https://github.com/SpaceMolt/admiral), the web UI for running and observing multiple SpaceMolt agents.

It keeps the core Admiral workflow, but adds several operational and LLM-orchestration features that are specific to this repo.

This fork was developed primarily with help from Codex as the main coding agent.

![Redacted Admiral dashboard](docs/assets/dashboard-redacted.png)

## What This Repo Is

- Bun + Hono backend with a Vite/React frontend
- Multi-profile SpaceMolt agent manager
- SQLite-backed local state in `data/admiral.db`
- Full per-agent logs, directives, command tools, and profile state

The app listens on `http://localhost:3031` by default.

## Quick Start

### From Source

```bash
git clone git@github.com:0-c3rax-0/admiral.git
cd admiral
bun install
bun run dev
```

For a production build:

```bash
bun run build
./admiral
```

Data is stored under:

- `data/admiral.db`
- `data/memory/` for persisted profile memory

## Main Features In This Fork

### Multi-agent control

Run multiple SpaceMolt profiles in parallel, each with its own:

- connection
- LLM loop
- directive
- logs
- TODO state
- persistent memory

### Connection modes

This repo supports:

- `http`
- `http_v2`
- `websocket`
- `websocket_v2`
- `mcp`
- `mcp_v2`

Mode summary:

- `http`: legacy polling mode
- `http_v2`: current HTTP API v2 mode
- `websocket`: legacy WebSocket mode
- `websocket_v2`: WebSocket transport with heartbeat handling, reconnect logic, and automatic re-authentication retry for recoverable auth failures
- `mcp`: legacy MCP mode
- `mcp_v2`: Model Context Protocol v2 mode with tool discovery

`websocket_v2` is documented in this fork because it is implemented as a distinct connection class, not just a label alias. Compared with the older `websocket` mode, it adds:

- heartbeat ping/pong monitoring
- reconnect backoff with stale-connection detection
- retry of commands after session-expired or session-invalid auth failures
- more defensive command send/error handling

For most users, `http_v2` remains the safer default. `websocket_v2` is the lower-latency persistent transport option when you specifically want a live socket connection and the game server path is stable enough for it.

### LLM providers

Configured providers include:

- Anthropic
- OpenAI
- Google AI
- Google Gemini OAuth (`google-gemini-cli`)
- Groq
- xAI
- Mistral
- MiniMax
- NVIDIA
- OpenRouter
- Ollama
- LM Studio
- Custom OpenAI-compatible endpoints

### Provider failover

Profiles can define a primary provider/model and a profile-level failover provider/model.

When the current model hits rate limits or provider reachability errors, Admiral can switch to the configured failover model for the same turn.

### Alternative solver

This fork supports an alternative solver path:

- trigger after N tool rounds
- switch the current turn to an alternative model
- if that alternative model fails, revert to the primary model
- if needed, still use the normal profile failover path afterward

This is useful for breaking repetitive loops without changing the default model for every request.

### Google Gemini OAuth

This repo includes a local OAuth flow for `google-gemini-cli`:

- start OAuth from the UI
- poll auth status
- detect current project ID
- store OAuth credentials in local preferences
- use refreshed OAuth credentials automatically through `@mariozechner/pi-ai`

### Persistent profile memory

Profiles can save and reload long-lived memory snapshots from `data/memory/`.

This memory is injected back into the agent context on later runs, separate from the transient turn context.

### Context compaction

The LLM loop can optionally compact context with a separate model/provider before requests get too large.

### Startup autoconnect

This fork can auto-connect enabled profiles on server startup, with configurable randomized delays to avoid a thundering herd.

### Runtime stats

The server periodically records profile runtime snapshots and events into SQLite for status/history views.

### TODO and captain's log

Each agent has:

- a local TODO list used by the agent loop
- access to the SpaceMolt captain's log through tools and UI

## Changes Compared To Upstream `SpaceMolt/admiral`

This fork currently adds or changes the following behavior relative to the normal Admiral repo:

### LLM orchestration changes

- profile-level failover provider/model support
- alternative solver support after configurable tool rounds
- clearer failover and alternative-solver logging
- compact-input / context-compaction settings
- restart recovery for in-flight requests persisted in SQLite

### Provider changes

- Google Gemini OAuth integration via `google-gemini-cli`
- OAuth status and project-detection endpoints in the backend
- frontend provider setup for OAuth login and manual redirect completion

### Agent-state changes

- persistent per-profile memory stored on disk
- local TODO tooling integrated into the agent loop
- additional captain's log tooling and side-panel usage

### Operations changes

- startup autoconnect with randomized delay windows
- periodic runtime stats snapshots/events
- built-in retention pruning for SQLite data
- successful `llm_requests` keep full context briefly, then are compacted later to reduce DB growth

## Fork-Specific Additions

- Google Gemini OAuth support with local browser login flow and stored OAuth refresh state
- alternative solver routing after configurable tool rounds
- profile-level primary/failover provider-model orchestration
- persistent per-profile memory stored on disk and reloadable from the UI
- local TODO support wired into the tool loop
- startup autoconnect for enabled profiles
- built-in runtime retention and SQLite growth controls

## Operational Differences From Upstream

- this fork is tuned more aggressively for unattended multi-agent operation
- LLM failover and alternative-solver behavior are first-class runtime features here
- local SQLite retention behavior is part of the application, not an external ops step
- successful LLM request payloads are intentionally compacted after a short diagnostic window
- Google OAuth-backed Gemini usage is supported alongside API-key-based providers

## Current Retention Behavior

This fork now applies built-in local retention without any external cron/systemd timer:

- rows older than 3 days are pruned from:
  - `llm_requests`
  - `log_entries`
  - `stats_snapshots`
  - `stats_events`
- successful `llm_requests` keep `system_prompt` and `messages_json` for 3 hours
- after 3 hours, successful requests are compacted by clearing those large fields
- failed, pending, and processing requests keep their full context for diagnosis and restart recovery

## Development Notes

Run the app in development:

```bash
bun run dev
```

Typecheck:

```bash
bun run typecheck
```

Production build:

```bash
bun run build
```

## Notes About Upstream

Upstream remains:

- canonical upstream: `https://github.com/SpaceMolt/admiral`

This fork is currently tracked from:

- fork remote: `git@github.com:0-c3rax-0/admiral.git`

If you need to compare behavior against upstream, start with:

```bash
git fetch upstream
git diff upstream/main...main
```
