# Admiral API Audit

Auditing all connection implementations + agent tooling against:
- `docs/openapi-v1.json` — 161 endpoints (flat, no prefix)
- `docs/openapi-v2.json` — 187 endpoints (namespaced under `/api/v2/`)

V2 namespaces: `spacemolt`, `spacemolt_auth`, `spacemolt_battle`, `spacemolt_catalog`,
`spacemolt_facility`, `spacemolt_faction`, `spacemolt_faction_admin`, `spacemolt_faction_commerce`,
`spacemolt_intel`, `spacemolt_market`, `spacemolt_salvage`, `spacemolt_ship`, `spacemolt_social`,
`spacemolt_storage`, `spacemolt_transfer`

---

## HTTP v1 (`src/server/lib/connections/http.ts`)

**Overall conformance: ~85% — core mechanics correct, gaps in completeness**

### What's correct
- Base URL construction (`serverUrl + '/api/v1'`) and POST routing
- `X-Session-Id` header auth, session creation via POST `/session`
- Request format (JSON body, flat args object)
- Response envelope parsing (`result`, `error`, `notifications`, `session`)
- Session expiry detection and coalesced re-session logic
- Rate-limit retry via `error.code === 'rate_limited'`

### Issues

- **No logout:** `disconnect()` only clears local state; never calls `/logout` endpoint
- **Under-extracted login/register responses:** Only pulls `player_id` — ignores `player`, `ship`, `system`, `poi`, `captains_log`, `pending_trades` from `LoginResponse` / `RegisterResponse`
- **No HTTP status code differentiation:** 400 and 429 not handled at the HTTP level (only inspects response body)
- **No command payload type validation:** `execute()` accepts generic `Record<string, unknown>` with no arg checking against spec

---

## HTTP v2 (`src/server/lib/connections/http_v2.ts`)

**Overall conformance: solid against current spec**

### What's correct
- Dynamically builds namespace routing map from the OpenAPI spec via `fetchToolMapping()` — covers all 15 namespaces and 187 endpoints automatically
- Falls back to v1 endpoints if spec unavailable
- Auth (`X-Session-Id`), request format, response envelope, session management all correct
- `structuredContent` correctly preferred over `result` for programmatic use
- Login/register route correctly through `spacemolt_auth` namespace
- Session coalescing on concurrent requests
- Rate-limit retry already uses `error.retry_after`

### Issues

- **🟡 MINOR: `/api/v2/notifications` endpoint not actively polled**
  - Notifications only arrive bundled with command responses
  - May miss notifications during idle periods

---

## WebSocket (`src/server/lib/connections/websocket.ts`)

**Overall conformance: CORRECT — gameserver-verified, no real issues**

### Confirmed against gameserver source

- `/ws` endpoint exists (server.go:366) ✓
- `{type, payload}` is the actual gameserver WS protocol — not the REST envelope (protocol/messages.go:373) ✓
- Response types `ok`, `error`, `logged_in`, `registered`, `version_info` all exist in gameserver ✓
- Notifications are intentionally sent as separate `{type, payload}` messages, newline-delimited ✓
- FIFO command queue (no request IDs) matches gameserver's single-threaded command processing ✓
- Login/register format `{type: "login", payload: {username, password}}` is correct ✓
- `welcome` message on connect is correctly treated as a notification ✓

### Notes
- Connection-based auth (no `X-Session-Id`) is correct for WebSocket — different model than REST by design
- The earlier audit flags were false positives from comparing WS to the REST OpenAPI spec

---

## MCP v1 (`src/server/lib/connections/mcp.ts`)

**Overall: CORRECT — all assumptions gameserver-verified**

### Confirmed against gameserver source
- `/mcp` endpoint exists (server.go:464) ✓
- `Mcp-Session-Id` header is correct (mcp/http.go:28) ✓
- Session timeout is 30 minutes (mcp/http.go:31) ✓
- `tools/call` JSON-RPC routing is correct ✓
- Response format `{content: [{type: "text", text: "..."}]}` is correct (http.go:1770) ✓
- `get_notifications` is a valid registered tool (http.go:1511) ✓

### Remaining minor issues
- **🟡 No session expiry detection/recovery** — server cleans up after 30 min; client should re-initialize on `session_expired` error
- **🟡 No retry on `initialize` failure**
- **🟡 Polling `get_notifications` after every command** — confirmed valid but adds a round-trip per call

---

## MCP v2 (`src/server/lib/connections/mcp_v2.ts`)

**Overall: CORRECT — all assumptions gameserver-verified**

### Confirmed against gameserver source
- `/mcp/v2` endpoint exists (server.go:468) ✓
- Same `Mcp-Session-Id` header (mcp/http.go:28) ✓
- `tools/list` returns action enums in `inputSchema.properties.action.enum` via `propEnum()` (v2_tools.go:1046) ✓
- v2 responses include `structuredContent` for mutations (v2_render.go:29) ✓ — v1 omits this field
- `get_notifications` is mapped and handled specially (v2_tools.go:168, v2_handler.go:393) ✓

### Remaining minor issues
- **🟡 Same session expiry non-handling as v1**
- **🟡 Same notification polling overhead**
- **🟡 Silent fallback to `spacemolt` tool for unrecognized commands** — user gets cryptic server error
- **🟡 `isQueryAction()` heuristic** — v2 doesn't expose mutation metadata (same fundamental issue as HTTP v2)

---

## Agent Loop / System Prompt (`src/server/lib/loop.ts`, `src/server/lib/agent.ts`)

**Overall: dynamically built from spec — mostly correct, with known v2 metadata limits**

### What's correct
- System prompt command list is **dynamically generated** by fetching the OpenAPI spec, not hardcoded
- Correctly classifies v1 commands as queries vs. actions using `x-is-mutation` flag
- Spec is cached in SQLite with 1-hour TTL

### Issues

- **🔴 V2 `x-is-mutation` is null on ALL endpoints** — every v2 command is presented to the LLM as a free query. Mining, attacking, crafting — all shown as free.
- **🔴 V2 operationIds are fully-qualified** (`spacemolt_market_view_market`, `spacemolt_social_captains_log_list`) — format is `{tool}_{action}` (openapi/v2.go:331). LLM sees these long names in the system prompt. `http_v2.ts` maps both short names and operationIds correctly, but the LLM has no context for the naming scheme.
- **🟡 Some v1 commands were removed/reorganized in v2** — agents running on v1 habits will still attempt unavailable commands unless prompted carefully
- **🟡 72 new v2 commands are not surfaced** unless the agent is actually on a v2 connection
- **🟡 System prompt doesn't state which API version is active** — no way for LLM to know it's on v1 vs v2
- **🟢 `get_commands` game endpoint not used** — spec is fetched statically. Reasonable tradeoff (pre-login, caching), but server runtime changes won't be seen.

---

## Commands Route + Frontend (`src/server/routes/commands.ts`, `src/frontend/src/components/CommandPanel.tsx`)

**Overall: mostly correct now, with remaining v2 metadata caveats**

### Commands route (`routes/commands.ts`)
- Accepts `api_version` and fetches `/api/v1` or `/api/v2` accordingly
- Cache key includes the API base URL, so v1 and v2 are separated
- Still canonicalizes names down to short aliases, which is useful for UX but hides the fully-qualified v2 operation IDs

### CommandPanel (`components/CommandPanel.tsx`)
- `GameCommandInfo` type defined locally instead of imported from shared types
- Sends bare command names to execute — works for v1, works for v2 because `http_v2.ts` does namespace routing internally
- `isMutation` icon logic will break on v2 (see below)

### QuickCommands (`components/QuickCommands.tsx`)
All 9 hardcoded commands are still routable in v2 via short-name mapping or alias resolution.

### V2 spec metadata issues
- **🔴 All `x-is-mutation` fields are `null` in v2 spec** — mutation detection breaks for all v2 commands, icons wrong everywhere
- V2 `get_commands` endpoint doesn't return parameter metadata needed by CommandPanel

---

## Response Schema Findings

### Login / Register

**HTTP v1 login `player_id` extraction — 🔴 BROKEN**
- `http.ts:41` reads `result.player_id` — this field does not exist in the login response
- Actual location: `session.player_id` in the response envelope, or `result.player.id`
- Impact: admiral cannot track the authenticated player_id after login via HTTP v1; `profile.player_id` stays null

**HTTP v1 register — username/empire not in result (🟡 minor)**
- `http.ts:62/65` reads `result.username` / `result.empire` — not in HTTP v1 result
- Falls back to function args (correct values), but not validated against server response
- `result.player.username` / `result.player.empire` are available if needed

**HTTP v2 login/register — CORRECT**
- v2 explicitly adds `session_id`, `username`, `empire` to the result object — admiral's parsers handle these fine

**WebSocket login — CORRECT**
- Admiral correctly reads `player.id` from `logged_in` payload ✓
- `registered` payload only has `password` + `player_id`; username/empire fall back to args (correct)

### V2 Parameter Scheme — MAJOR ARCHITECTURAL CHANGE

V2 replaced command-specific named parameters with a **generic unified scheme**:

| v1 param name | v2 param name | Used for |
|---|---|---|
| `target_poi`, `target_id`, `item_id`, `station_id`, etc. | `id` | Any target identifier |
| `quantity` | `quantity` | Same name, no change |
| `channel`, `target_id` (chat) | `target` | Chat target/channel |
| `target` (refuel) | removed | Fuel target |
| `auto_list`, `deliver_to` (buy/sell) | removed | Removed options |
| `target_system` (jump) | `id` | Jump destination |

**CONFIRMED NON-ISSUE for admiral:** `v2_translate.go` has explicit passthrough — any param NOT in the declared rename mapping passes through unchanged to the v1 handler (v2_translate.go:50-55). Go's JSON unmarshaling ignores unknown fields. So `{target_poi: "sol_belt"}`, `{item_id: "iron_ore"}`, `{channel: "system"}` all work on v2 unchanged. v1-style param names are fully backward compatible.

Notable v2 renames (documented in spec, but both styles work):
- `chat`: `channel` → `target`, `target_id` → `target`
- `sell`/`buy`: `item_id` → `id`
- `travel`: `target_poi` → `id`
- `jump`: `target_system` → `id`

**`structuredContent` vs `result`** — http_v2.ts already handles this correctly (prefers `structuredContent`).

**`get_ship` modules in v2** — CONFIRMED NON-ISSUE: OpenAPI spec claiming "array of strings" is wrong. v2 `get_ship` returns full `V2Module` objects with quality, wear, stats map, cpu/power (v2state.go:252). Richer than v1. Also: `get_state` (new v2 command) returns the full combined state blob (`V2GameState`: player + ship + modules + cargo + location + missions + queue + skills) in one call — `PlayerStatus.tsx`'s `location.system_name` fallback applies here.

### `get_status` — CORRECT
All fields admiral reads are confirmed correct against Go structs (handlers/info.go, models/ship.go):
- `player.credits`, `player.current_system`, `player.current_poi` ✓
- `ship.hull/max_hull`, `shield/max_shield`, `fuel/max_fuel`, `cargo_used/cargo_capacity`, `cpu_used/cpu_capacity`, `power_used/power_capacity` ✓
- V2 uses the same handler — no structural difference
- `data.location.system_name/poi_name` fallback in PlayerStatus.tsx is defensive code for other commands (e.g. `get_location`), not present in `get_status`

---

## Cross-Cutting Issues

### 🔴 Critical

1. **V2 `x-is-mutation` intentionally absent** — CONFIRMED: v2 determines mutation status at runtime from command registry, not the spec. Admiral's system prompt and frontend will mislabel v2 mutations as free queries.
2. **HTTP v1 login `player_id` not extracted** (`http.ts`) — reads `result.player_id` which doesn't exist; should be `session.player_id` from envelope or `result.player.id`. Profile's `player_id` stays null after login.

### 🟠 High

4. ~~**WebSocket response envelope drops `error`/`notifications`/`session`**~~ — CONFIRMED NON-ISSUE: WS protocol uses `{type, payload}` natively (protocol/messages.go:373), not the REST APIResponse envelope. Admiral is correct.
5. ~~**V2 parameter names changed**~~ — CONFIRMED NON-ISSUE: `v2_translate.go` passthrough (line 50-55) means all v1-style named params work unchanged on v2. Both `{target_poi: "x"}` and `{id: "x"}` route correctly to `travel`.
6. ~~**`chat` params renamed**~~ — CONFIRMED NON-ISSUE: same passthrough; `{channel: "system"}` works on v2.
7. ~~**`get_ship` modules broken on v2**~~ — CONFIRMED NON-ISSUE: v2 returns full `V2Module` objects, not string IDs. OpenAPI spec was inaccurate.
8. ~~**QuickCommands has 2 commands invalid in v2**~~ — CONFIRMED NON-ISSUE: `view_market` and `captains_log_list` still route in v2. `http_v2.ts` maps short names to the correct namespace dynamically.
6. **No logout endpoint called anywhere** — CONFIRMED NON-ISSUE: gameserver logout only updates `LastActiveAt`, no critical cleanup. Sessions expire after 30 min naturally. Dropping the session is fine.

### 🟡 Medium

7. **MCP polling `get_notifications` after every command** — confirmed valid tool call, but adds a round-trip per command
8. **MCP session expiry not handled** — confirmed 30-min timeout (mcp/http.go:31); neither MCP client re-initializes on `session_expired`
9. **MCP v2 silent fallback to `spacemolt` tool** for unrecognized commands — cryptic server error instead of helpful message
10. **System prompt doesn't indicate API version** — LLM doesn't know if it's on v1 or v2
11. **Frontend `GameCommandInfo` type not in shared types** — duplicated locally in CommandPanel.tsx
12. **`agentlogs` endpoint disabled server-side** — returns HTTP 410 Gone. Both specs still document it. Non-issue for admiral since it uses its own local SQLite logs.

---

## V1 vs V2 Notable Differences (from spec)

- `name_ship` (v1) → `spacemolt_ship/rename_ship` (v2)
- `buy_ship` (v1) → removed from current v2 spec; use `buy_listed_ship` or `commission_ship`
- `shipyard_showroom` (v1) → removed from current v2 spec; use catalog/listing flows instead
- `set_anonymous` (v1) → removed from current v2 spec
- `deposit_credits` / `withdraw_credits` (v1) → deprecated; no v2 equivalent because personal credits now live only in wallet
- `buy_insurance` (v1) → `spacemolt_salvage/insure` (v2)
- `get_insurance_quote` (v1) → `spacemolt_salvage/quote` (v2)
- V2 adds `get_player`, `get_queue`, `get_state`, `get_version`, `get_ships`
- V2 faction commands restructured into `spacemolt_faction` / `spacemolt_faction_admin` / `spacemolt_faction_commerce`
- V2 adds `spacemolt_intel` group (intel/trade_intel commands)
- V2 adds `spacemolt_storage` group (`deposit`, `withdraw`, `view`)
- V2 adds `spacemolt_transfer` group (trade_* commands)
- V2 adds `spacemolt_social` group (chat, notes, forum, captains_log, etc.)

## Command Migration Impact In Admiral

- No production code currently calls removed v2 commands like `buy_ship`, `shipyard_showroom`, or `set_anonymous`.
- Storage command aliases remain intentionally supported in code:
  - `deposit_items` → `storage_deposit`
  - `withdraw_items` → `storage_withdraw`
  - `view_storage` → `storage_view`
  - grouped `storage(action=...)` also resolves correctly
- Prompting text still mentions aliases and grouped storage forms. That is not broken, but it is worth keeping prompts aligned with the current v2 terminology so agents do not learn obsolete names first.
