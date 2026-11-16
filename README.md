# Frigate Alerts

Send Frigate NVR alerts to multiple Telegram groups with real-time MQTT event detection, per-camera scheduling, label filtering, a web management GUI, and an MCP HTTP API for AI tool integration.

## Features

- 📡 **Real-Time MQTT** — Instant event detection via Frigate's MQTT feed (no polling)
- 📱 **Multiple Telegram Groups** — Send alerts to different groups per camera
- ⏰ **Per-Camera Scheduling** — Set different alert windows for each camera or group
- 🔔 **Always Send** — Bypass schedule for critical cameras
- 🏷️ **Label Filtering** — Only alert on specific object types per camera
- 📹 **Media Attachments** — Sends video clips, snapshots, or thumbnails with automatic fallback
- 🔗 **Webhook Support** — Trigger external webhooks on events
- 🔄 **Startup Catch-Up** — Recovers missed events on restart
- 🌐 **Web GUI** — Browser-based management interface for all settings
- 💤 **Snooze** — Silence alerts globally, per camera, or per group for a set duration
- 🔌 **MCP HTTP API** — AI tool integration via the Model Context Protocol
- 🔑 **Token-Based Auth** — Scoped MCP tokens (snooze-only or admin)

---

## Prerequisites

- **Node.js** v16+
- **Frigate NVR** with MQTT enabled
- **MQTT Broker** (e.g., Mosquitto) — Frigate must publish to it
- **Telegram Bot** — create via [@BotFather](https://t.me/BotFather)

---

## Installation

```bash
npm install
```

Or on Linux, use the install script which also installs Mosquitto and sets up a systemd service:

```bash
sudo ./install
```

---

## Running

```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

On startup you will see:

```
🔑 Auth config created → auth.json
   Web login:    admin / admin  (change in Settings)
   MCP admin:    fa-abc123...
   MCP snooze:   fa-def456...
🌐 Web GUI:      http://localhost:8099
🔌 MCP endpoint: http://localhost:8099/mcp
📡 REST API:     http://localhost:8099/api
```

The web GUI port defaults to **8099**. Override with `GUI_PORT` env var or `server_port` in `config.json`.

---

## Web GUI

Open **http://localhost:8099** in your browser. You will be prompted to log in.

**Default credentials:** `admin` / `admin` — change these immediately in **Settings → Auth & Security**.

### Dashboard

- Service status, uptime, camera/group counts
- Active snooze banner (shown when any snooze is active)
- **Quick Snooze** — one-click global snooze for 15 min, 30 min, 1 hour, or 2 hours

### Settings

Configure all global settings without editing `config.json` by hand:

| Section | What you can change |
|---------|---------------------|
| **General** | Frigate API URL, Telegram bot token, webhook URL, media delay/retry settings |
| **MQTT** | Broker host, topic prefix, username/password |
| **Default Schedule** | Fallback alert window and default groups |
| **MCP Tokens** | Create, copy, and delete scoped MCP tokens |
| **Web Credentials** | Change the web UI username and password |

Changes saved via the GUI take effect immediately — no restart required.

### Cameras

View, add, edit, and delete camera configurations. Each row shows:
- Assigned groups
- Label filter
- Schedule
- Always Send toggle
- A **💤 30m** quick-snooze button

### Groups

View, add, edit, and delete Telegram group configurations. Each row shows:
- Chat ID
- Enabled status
- Always Send toggle
- Schedule
- A **💤 30m** quick-snooze button

### Snooze

Full snooze management:

- **Active snoozes** — list with remaining time and a Clear button per entry
- **Add Snooze** — choose target type (Global / Camera / Group), then set duration or exact end time

---

## Snooze

Snooze suppresses alert delivery without changing any configuration. Snooze state is persisted to `snooze.json` so it survives restarts.

### Snooze Targets

| Target format | Effect |
|---------------|--------|
| `global` | Suppresses all alerts from all cameras |
| `camera:<name>` | Suppresses all alerts from that camera |
| `group:<name>` | Skips that group for all cameras |

### Snooze Modes

**Duration** — snooze for X minutes from now:
```bash
curl -X POST http://localhost:8099/api/snooze \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{"target": "global", "duration_minutes": 60}'
```

**Until** — snooze until a specific datetime:
```bash
curl -X POST http://localhost:8099/api/snooze \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{"target": "camera:front_door", "until_datetime": "2025-06-01T08:00:00"}'
```

**Clear** a specific target:
```bash
curl -X DELETE http://localhost:8099/api/snooze/camera:front_door \
  -H "Authorization: Bearer <session-token>"
```

**Clear all** snoozes:
```bash
curl -X DELETE http://localhost:8099/api/snooze \
  -H "Authorization: Bearer <session-token>"
```

**View active snoozes:**
```bash
curl http://localhost:8099/api/snooze \
  -H "Authorization: Bearer <session-token>"
```

```json
{
  "global": {
    "until": 1748774400000,
    "description": "60 minutes",
    "remaining_display": "58m 42s",
    "until_display": "6/1/2025, 8:00:00 AM"
  }
}
```

---

## Authentication

### Web GUI

The web interface uses session tokens. Log in at **http://localhost:8099** with your username and password. The session is stored in `localStorage` and expires after 24 hours.

Credentials are stored (hashed) in `auth.json`. Change them via **Settings → Auth & Security** or via the REST API:

```bash
curl -X POST http://localhost:8099/api/auth/password \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "my-new-password"}'
```

### MCP Tokens

MCP tokens are long-lived Bearer tokens used to authenticate AI tools and scripts against the MCP and REST API endpoints. They are stored in `auth.json`.

Two tokens are created by default on first run and printed to the console. **Copy them then** — you can always copy them again later from **Settings → MCP Tokens → Copy**.

#### Token Scopes

| Scope | Tools available |
|-------|----------------|
| `snooze` | `get_status`, `get_snooze_state`, `set_snooze`, `clear_snooze` |
| `admin` | All snooze tools + `get_config`, `update_config`, all camera/group tools, `restart_service` |

#### Managing Tokens via the GUI

Go to **Settings → MCP Tokens**:

- **Create** — enter a name, pick a scope, click **+ Create Token**. The full token is shown once — click **Copy** immediately.
- **Copy later** — click the **Copy** button on any existing token row to copy the full value to your clipboard at any time.
- **Delete** — click **Delete** to revoke a token immediately.

#### Managing Tokens via the API

**List tokens** (shows preview, not full value):
```bash
curl http://localhost:8099/api/auth/mcp-tokens \
  -H "Authorization: Bearer <session-token>"
```

**Create a token:**
```bash
curl -X POST http://localhost:8099/api/auth/mcp-tokens \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Home Assistant", "scope": "snooze"}'
# Returns: { "id": "...", "token": "fa-full-token-value..." }
# Save the token value — this is the only time it is returned by this endpoint.
```

**Copy a token's full value at any time:**
```bash
curl http://localhost:8099/api/auth/mcp-tokens/<id>/value \
  -H "Authorization: Bearer <session-token>"
# Returns: { "token": "fa-full-token-value..." }
```

**Delete a token:**
```bash
curl -X DELETE http://localhost:8099/api/auth/mcp-tokens/<id> \
  -H "Authorization: Bearer <session-token>"
```

---

## MCP HTTP API

The MCP endpoint implements the [Model Context Protocol](https://modelcontextprotocol.io) Streamable HTTP transport. It allows AI assistants (Claude, etc.) to manage your Frigate Alerts configuration and snooze settings through tool calls.

**Endpoint:** `POST http://localhost:8099/mcp`  
**Auth:** `Authorization: Bearer <mcp-token>`

The tools exposed depend on the token's scope. A `snooze`-scoped token only sees snooze tools; an `admin`-scoped token sees everything.

### Available MCP Tools

#### Status
| Tool | Scope | Description |
|------|-------|-------------|
| `get_status` | snooze + admin | Service uptime, camera/group counts, active snoozes, connection info |

#### Config (admin only)
| Tool | Description |
|------|-------------|
| `get_config` | Get the full current configuration |
| `update_config` | Deep-merge updates into the config (e.g. change `frigate_api_url`) |

#### Cameras (admin only)
| Tool | Description |
|------|-------------|
| `get_cameras` | List all camera configurations |
| `add_camera` | Add or replace a camera (name, groups, labels, schedule, always_send) |
| `update_camera` | Update specific fields of a camera |
| `remove_camera` | Remove a camera |

#### Groups (admin only)
| Tool | Description |
|------|-------------|
| `get_groups` | List all group configurations |
| `add_group` | Add or replace a group (name, chat_id, enabled, always_send, schedule) |
| `update_group` | Update specific fields of a group |
| `remove_group` | Remove a group |

#### Snooze (snooze + admin)
| Tool | Description |
|------|-------------|
| `get_snooze_state` | Get all active snoozes with remaining time |
| `set_snooze` | Snooze a target for `duration_minutes` or until `until_datetime` |
| `clear_snooze` | Clear snooze for a target, or all snoozes if target is omitted |

#### Service (admin only)
| Tool | Description |
|------|-------------|
| `restart_service` | Restart the service (exits process; systemd/nodemon brings it back) |

### Connecting Claude to the MCP Endpoint

Add to your `claude_desktop_config.json` (or equivalent MCP client config):

```json
{
  "mcpServers": {
    "frigate-alerts": {
      "url": "http://localhost:8099/mcp",
      "headers": {
        "Authorization": "Bearer fa-your-admin-token-here"
      }
    }
  }
}
```

Claude can then call tools like:

> **"Snooze all cameras for 2 hours while I'm mowing the lawn"**
> → Claude calls `set_snooze` with `target: "global"`, `duration_minutes: 120`

> **"Add a camera called garage that only alerts the security group between 10pm and 6am"**
> → Claude calls `add_camera` with the appropriate schedule config

> **"What cameras are currently configured?"**
> → Claude calls `get_cameras` and summarises the result

### Testing the MCP Endpoint Manually

Check what tools are available for a token:
```bash
curl http://localhost:8099/mcp/info \
  -H "Authorization: Bearer fa-your-token"
```

Send a raw MCP tool call:
```bash
curl -X POST http://localhost:8099/mcp \
  -H "Authorization: Bearer fa-your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "set_snooze",
      "arguments": {
        "target": "global",
        "duration_minutes": 30
      }
    }
  }'
```

---

## REST API

All REST API endpoints require a web session token in the `Authorization: Bearer <token>` header. Obtain a session token by logging in:

```bash
curl -X POST http://localhost:8099/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin"}'
# Returns: { "token": "ws-...", "user": "admin" }
```

### Endpoints

#### Auth
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/login` | Login — returns session token |
| `POST` | `/auth/logout` | Logout — invalidates token |
| `GET` | `/auth/me` | Validate session — returns `{ user }` |
| `POST` | `/api/auth/password` | Change web credentials |
| `GET` | `/api/auth/mcp-tokens` | List MCP tokens (masked) |
| `POST` | `/api/auth/mcp-tokens` | Create MCP token — returns full token |
| `GET` | `/api/auth/mcp-tokens/:id/value` | Get full token value |
| `DELETE` | `/api/auth/mcp-tokens/:id` | Delete MCP token |

#### Status
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Service status, uptime, snooze state |

#### Config
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Get full config |
| `PUT` | `/api/config` | Replace full config |
| `PATCH` | `/api/config` | Deep-merge partial update |

#### Cameras
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/cameras` | List cameras |
| `POST` | `/api/cameras` | Add camera (`{ name, ...config }`) |
| `PUT` | `/api/cameras/:name` | Replace camera config |
| `DELETE` | `/api/cameras/:name` | Delete camera |

#### Groups
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/groups` | List groups |
| `POST` | `/api/groups` | Add group (`{ name, ...config }`) |
| `PUT` | `/api/groups/:name` | Replace group config |
| `DELETE` | `/api/groups/:name` | Delete group |

#### Snooze
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/snooze` | Get active snoozes |
| `POST` | `/api/snooze` | Set snooze (`{ target, duration_minutes }` or `{ target, until_datetime }`) |
| `DELETE` | `/api/snooze` | Clear all snoozes |
| `DELETE` | `/api/snooze/:target` | Clear one snooze (URL-encode `:` e.g. `camera%3Afront_door`) |

---

## Configuration

Create `config.json` (see `config.example.json` for a full example):

```json
{
  "frigate_api_url": "http://10.0.0.10:5000/api",
  "telegram_bot_token": "YOUR_BOT_TOKEN",
  "webhook_url": null,
  "server_port": 8099,

  "mqtt": {
    "host": "mqtt://10.0.0.10",
    "topic_prefix": "frigate",
    "username": null,
    "password": null
  },

  "media_ready_delay_seconds": 5,
  "media_retry_attempts": 4,
  "media_retry_delay_seconds": 3,

  "default_schedule": {
    "start_time": "00:00",
    "end_time": "23:59",
    "always_send": false
  },

  "groups": {
    "family": {
      "chat_id": "-123456789",
      "enabled": true,
      "always_send": false,
      "schedule": { "start_time": "18:00", "end_time": "08:00" },
      "description": "Family — evening and night alerts"
    },
    "security": {
      "chat_id": "-987654321",
      "enabled": true,
      "always_send": true,
      "description": "Security team — 24/7"
    }
  },

  "default_groups": ["family"],

  "cameras": {
    "front_door": {
      "groups": ["family", "security"],
      "labels": ["person", "car"],
      "schedule": { "start_time": "17:00", "end_time": "07:00" }
    },
    "backyard": {
      "groups": ["security"],
      "always_send": true
    }
  }
}
```

### Alert videos

```json
"video": {
  "quality": "compressed",
  "max_mb": 8,
  "transcoder_socket": "/run/s24-transcode.sock"
}
```

| Key | Default | Meaning |
|---|---|---|
| `quality` | `original` | `original` sends Frigate's clip as it is. `compressed` shrinks any clip over `max_mb` before it is sent. |
| `max_mb` | `8` | The largest clip `compressed` sends unchanged. |
| `transcoder_socket` | none | The UNIX socket of a transcoder that shrinks clips (on a sitebox, `s24-transcode.socket`). Without one nothing is shrunk. |
| `timeout_seconds` | `120` | How long to wait for the transcoder. |

A group can set its own `"video_quality": "original"` or `"compressed"`; groups sharing a chat share its file.
Either way a clip over Telegram's 50 MB bot upload limit is shrunk, since Telegram would refuse it. If shrinking
fails or takes too long, the original is sent, so no alert is lost.

The transcoder protocol: connect, send one line `S24T1 <target bytes>`, then the clip, and close your side. The
answer is the new MP4, or a line starting with `ERR`.

### Schedule Priority

When resolving which schedule applies, the most specific rule wins:

```
camera.group_schedules[group]   ← most specific
  └─ camera.schedule
       └─ group.schedule
            └─ default_schedule  ← fallback
```

Schedules support crossing midnight — e.g. `22:00` → `06:00` works correctly.

### Mosquitto — Allow Remote Connections

By default Mosquitto 2.x only listens on `127.0.0.1`. To allow remote connections:

```bash
# /etc/mosquitto/conf.d/listen.conf
listener 1883 0.0.0.0
allow_anonymous true
```

```bash
sudo systemctl restart mosquitto
```

---

## How It Works

```
Frigate detects object
  └─ MQTT "new"
       ├─ Label allowed? → skip if not
       ├─ Snoozed? → skip if active snooze covers this camera
       ├─ In schedule? → skip if outside window
       └─ Start 60s safety timer
            └─ MQTT "end" (or timeout)
                 └─ Wait media_ready_delay_seconds
                      └─ Download media: video → snapshot → thumbnail
                           └─ Filter snoozed groups
                                └─ Send to Telegram
```

- **Short events** (object detected and leaves): full video clip
- **Long events**: if `"end"` doesn't arrive in 60s, sends with snapshot
- **On startup**: catches events from the last 5 minutes via the HTTP API

---

## Installing as a Service (Linux)

```bash
sudo ./install          # Install and start
./install status        # Show status
./install logs          # Live logs
./install restart       # Restart
./install uninstall     # Remove
```

---

## Files Created at Runtime

| File | Purpose |
|------|---------|
| `auth.json` | Web credentials (hashed) and MCP tokens |
| `snooze.json` | Persisted snooze state (survives restarts) |

Both are gitignored by default.
