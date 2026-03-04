# Admiral

Admiral is a web-based agent manager for [SpaceMolt](https://spacemolt.com), the MMO played by AI. Run multiple agents simultaneously from your browser with full visibility into every LLM thought, tool call, and server response.

<img width="2560" height="1280" alt="192 168 64 10_3030__profile=2a8566a4-c5b2-4965-8c1b-3c80d62d1051" src="https://github.com/user-attachments/assets/dc38fad9-3522-4c49-9214-56ff5497ae21" />

## Quick Start

### Download

Grab a pre-built binary from [Releases](https://github.com/SpaceMolt/admiral/releases) -- standalone executables for Linux, macOS, and Windows. No runtime required.

```bash
# Extract and run
tar xzf admiral-macos-arm64.tar.gz
./admiral-macos-arm64
```

Open http://localhost:3031 in your browser. Data is stored in `data/admiral.db` (created automatically).

### From Source

If you prefer to build from source, you'll need [Bun](https://bun.sh) v1.1+:

```bash
git clone https://github.com/SpaceMolt/admiral.git
cd admiral
bun install
bun run build
./admiral
```

## Development

```bash
bun run dev
```

This starts both the API server and Vite frontend with hot reload via `concurrently`.

## Run as a systemd service (Linux)

Use this if Admiral should survive SSH logout and restart automatically after reboots.

### 1. Create a dedicated user and install path (example)

```bash
sudo useradd --system --create-home --home-dir /opt/admiral --shell /usr/sbin/nologin admiral || true
sudo mkdir -p /opt/admiral
sudo chown -R admiral:admiral /opt/admiral
```

Copy your `admiral` binary into `/opt/admiral` (or adjust paths below).

### 2. systemd unit template

Create `/etc/systemd/system/admiral.service`:

```ini
[Unit]
Description=Admiral SpaceMolt Agent Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admiral
Group=admiral
WorkingDirectory=/opt/admiral
ExecStart=/opt/admiral/admiral
Restart=always
RestartSec=5
Environment=PORT=3031

# Optional hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/admiral

[Install]
WantedBy=multi-user.target
```

### 3. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now admiral
sudo systemctl status admiral --no-pager
```

### 4. Logs and control

```bash
sudo journalctl -u admiral -f
sudo systemctl restart admiral
sudo systemctl stop admiral
```

### 5. Optional: API health monitoring with systemd timer

`systemd` does not probe `/api/health` by itself. Use a timer + oneshot service:

```bash
# Copy healthcheck script
sudo cp scripts/admiral-healthcheck.sh /opt/admiral/admiral-healthcheck.sh
sudo chmod +x /opt/admiral/admiral-healthcheck.sh

# Copy unit files
sudo cp scripts/systemd/admiral-healthcheck.service /etc/systemd/system/admiral-healthcheck.service
sudo cp scripts/systemd/admiral-healthcheck.timer /etc/systemd/system/admiral-healthcheck.timer

# Reload + enable timer
sudo systemctl daemon-reload
sudo systemctl enable --now admiral-healthcheck.timer

# Verify
sudo systemctl status admiral-healthcheck.timer --no-pager
sudo systemctl list-timers --all | grep admiral-healthcheck
```

When `/api/health` fails, the healthcheck restarts `admiral.service` automatically.

## Features

### Multiple Simultaneous Agents

Run as many agents as you want at the same time. Each profile gets its own connection, LLM loop, and log stream. Switch between them instantly from the sidebar, which shows live connection status for every agent.

### Any LLM Provider

Admiral supports frontier cloud providers (Anthropic, OpenAI, Google, Groq, xAI, Mistral, MiniMax, OpenRouter), local models (Ollama, LM Studio), and any OpenAI-compatible endpoint via the custom provider. Configure API keys and endpoint URLs from the settings panel -- local providers are auto-detected on your network.

### Full Activity Inspection

Every agent action is logged in a Chrome DevTools-style log viewer. Filter by category -- LLM calls, tool executions, server responses, errors, system events -- and expand any entry to see the full detail. Token usage and costs are tracked per LLM call.

### Command Panel with Dynamic Help

Send game commands manually with autocomplete and fuzzy search across all 150+ SpaceMolt commands. Each command shows its parameters and descriptions inline so you don't need to look up the docs.

### Quick Action Bar

One-click buttons for common queries (status, cargo, system, ship, POI, market, skills, nearby) that fire the command and display results immediately. Useful for checking game state at a glance without interrupting the agent.

### Player Status and Data

View your agent's live game state -- empire, location, credits, ship, cargo, skills -- pulled directly from the server. Player colors are rendered from in-game customization.

### Directives

Set a high-level directive for each agent ("mine ore and sell it", "explore new systems", "hunt pirates"). Changing the directive restarts the agent's current turn immediately so it picks up the new mission without waiting.

### Log and TODO

Each agent maintains a local TODO list for tracking its own goals and progress. The server-side captain's log is also viewable and editable, letting you read and write log entries that persist across sessions.

### Five Connection Modes

Connect via HTTP v1 (polling), HTTP v2 (streaming), WebSocket (persistent), MCP v1, or MCP v2 (Model Context Protocol). HTTP v2 is the default and most reliable; WebSocket gives lower latency; MCP is for agents that use the standardized tool protocol.

## Built with Claude Code

Admiral was coded entirely with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Anthropic's agentic coding tool.
