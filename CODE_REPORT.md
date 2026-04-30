# CANGateway — Code, API & Database Report

End-to-end audit of the **Bubble Monitor / CANGateway Dashboard** repository. Covers the full-stack application: Python FastAPI backend, React/Vite frontend, optional Tauri native shell, and PostgreSQL database layer.

---

## 1. Project Overview

**Name:** CANGateway (formerly "Bubble Monitor Dashboard")
**Purpose:** Real-time monitoring, control, and historical analysis of STM32-based CAN bus boards. Each device exposes **15 digital outputs (DO1–DO15)** and **4 digital inputs (DI1–DI4)**.
**Connectivity:** TCP/IP, UDP, or USB-CAN (Waveshare USB-CAN-B / CANalyst-II via `python-can` + `canalystii`).

### Stack Summary

| Tier | Technology | Role |
|---|---|---|
| Hardware | STM32 CAN boards @ 500 kbps | Physical I/O: 15 outputs, 4 inputs |
| Backend | Python 3.11 · FastAPI · Uvicorn · Prisma Client Python | REST API, WebSocket bridge, CAN bus I/O, history persistence |
| Frontend | React 18 · TypeScript · Vite · TailwindCSS · shadcn/ui · Recharts · react-router-dom | Live dashboard, board control, traffic generation |
| Native Shell | Tauri v2 (Rust) | Optional desktop wrapper with native TCP performance |
| Database | PostgreSQL 18 via Prisma ORM | Single source of truth (9 models) |

### Repository Structure

```
bubble-monitor-dashboard-main/
├── backend-py/              # Python FastAPI backend
│   ├── main.py              # App entrypoint + Uvicorn runner
│   ├── database.py          # Prisma CRUD + retention
│   ├── history_recorder.py  # In-memory dedup + throttle for history writes
│   ├── serial_bridge.py     # USB-CAN WebSocket bridge
│   ├── tcp_server.py        # Multi-board TCP simulator
│   ├── udp_server.py        # UDP simulator
│   ├── live_demo.py         # Demo data seeder
│   ├── migrate_sqlite_to_pg.py
│   ├── seed_demo_history.py
│   ├── boards/              # REST + WS /boards, /toggle, /send, /ws/boards
│   ├── config/              # REST /config, /timers, /rules, /automation/linked
│   ├── connect/             # WS /ws/tcp (TCP/UDP bridge)
│   ├── history/             # REST /history/sensors, /frames, /boardlogs (+CSV)
│   ├── logs/                # REST /logs in-memory state-change feed
│   ├── status/              # REST /, /status
│   ├── protocol/cref.py     # CAN encode/decode + CREF frame protocol
│   ├── websocket/manager.py # Broadcast manager for /ws/boards subscribers
│   ├── prisma/schema.prisma # 9-model schema
│   └── tests (test_*.py)    # bridge roundtrip, reconnect, RX, bytes, e2e, postgres, history
├── src/                     # React frontend
│   ├── App.tsx              # Router + providers
│   ├── contexts/            # TcpContext, BoardContext (core state)
│   ├── hooks/useTcpStream.ts
│   ├── pages/               # Dashboard, Connect, BoardControl, BoardConfig,
│   │                        # SendData, ServerMonitor, Logs, CrefMessages, Settings
│   ├── components/          # AppSidebar, DashboardLayout, CanBusLoader, ui/*
│   └── lib/utils.ts
├── src-tauri/               # Rust Tauri native shell (native TCP client)
├── docs/                    # System-Architecture.md, CAN-Bus-Loader-Guide.md
├── docker-compose.yml       # Backend + TCP simulator services
├── package.json             # Vite/React deps + `tauri` script
├── vite.config.ts           # Dev on :8080, alias `@` → ./src
└── README.md
```

---

## 2. Backend (Python / FastAPI)

### Entrypoint — [backend-py/main.py](backend-py/main.py)

- FastAPI app `CANGateway v1.0.0`
- **CORS:** wide open (`allow_origins=["*"]`)
- **Routers mounted:** `status`, `boards`, `connect`, `config`, `logs`, `history`, `serial_bridge`
- **Startup hook:** `connect_db()` → Prisma connect, initial `prune_history(30)`, then an async `_prune_loop()` task that runs `prune_history(RETENTION_DAYS=30)` every 24 h
- **Shutdown hook:** cancels prune task, disconnects Prisma
- **Listens on:** `0.0.0.0:8000`, reload enabled

### Protocol Layer — [backend-py/protocol/cref.py](backend-py/protocol/cref.py)

| Symbol | Purpose |
|---|---|
| `CAN_OUTPUT_ID = "100"` | Host → board: 2-byte output command (15 relays packed into bits) |
| `CAN_INPUT_ID = "200"` | Board → host: 1-byte input status (4 DI bits) |
| `encode_outputs(bools) → bytes` | 15 bools → 2 bytes (b0 = bits 0–7, b1 = bits 8–14) |
| `decode_outputs(bytes) → bools` | Inverse; returns 15 booleans |
| `decode_inputs(byte) → bools` | 1 byte → 4 booleans |
| `encode_board_state` / `decode_board_state` | Full state as 3 bytes (2 out + 1 in) |
| `CrefFrame` dataclass | `CREF|type|client|command|board_id|len|hex_data|ts` multi-board text frame |
| `Board` dataclass | Runtime record: id, outputs[15], inputs[4], status, ip, port, last_heartbeat |

**Frame example:** Turn on DO1, DO3, DO6 → `100#1500`

### Board Registry — [backend-py/boards/service.py](backend-py/boards/service.py)

In-memory stores:
- `board_registry: Dict[str, Board]` — live state
- `board_writers: Dict[str, asyncio.StreamWriter]` — TCP writers keyed by board id

Functions:
- `register_board(board_id, ip, port, writer)` — upsert + broadcast `boards_list` over WS
- `update_board(board)` — broadcast `board_update`
- `get_all_boards()`, `get_board(id)`

### WebSocket Manager — [backend-py/websocket/manager.py](backend-py/websocket/manager.py)

Simple broadcast hub. Maintains `clients: List[WebSocket]`, removes dead clients on broadcast failure.

### History Recorder — [backend-py/history_recorder.py](backend-py/history_recorder.py)

Two cross-cutting gates sit between the hot receive loop and the DB:

1. **CommLog dedup:** only persist a frame when `(board_id, direction, can_id)` text differs from the previous one (kills repetitive sensor frames).
2. **SensorReading throttle:** at most one parsed row per `(board_id, can_id)` per second (1.0 s default).
3. **BoardLog state-change guard:** `log_state_change()` only writes if the new value differs from the last seen value for `(board, type, index)`.

`*_bg` variants schedule as fire-and-forget tasks so the receive loop never blocks on DB writes.

### REST + WebSocket Surface

Complete working API, by router. All paths are relative to `http://localhost:8000`.

#### Status — [backend-py/status/routes.py](backend-py/status/routes.py)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Health ping (`"CANGateway Backend Running"`) |
| GET | `/status` | `{total_boards, online, offline}` |

#### Boards — [backend-py/boards/routes.py](backend-py/boards/routes.py)

| Method | Path | Body / Params | Purpose |
|---|---|---|---|
| GET | `/boards` | — | Full list of boards (`[Board.to_dict()]`) |
| GET | `/boards/{board_id}` | path: board_id | Single board detail |
| POST | `/toggle` | `ToggleCommand{board_id, output_index, value}` | Set one output; logs state; writes `100#xxxx` TCP frame if writer exists |
| POST | `/send` | `WriteCommand{board_id, outputs: bool[]}` | Overwrite all 15 outputs; bulk log + TCP send |
| WS | `/ws/boards` | — | Live updates. On connect: `{type:"boards_list", boards}`. Accepts commands `{command: "toggle"\|"write"\|"refresh"}`. |

#### Connect (TCP/UDP bridge) — [backend-py/connect/routes.py](backend-py/connect/routes.py)

| Method | Path | Purpose |
|---|---|---|
| WS | `/ws/tcp` | Bidirectional CAN-over-TCP (or UDP) bridge for browser-mode clients. First message = `{ip, port, protocol}`; then raw frames stream both ways. Auto-registers the board, parses `200#XX` → inputs, recognises `CREF` REGISTER/STATUS/HEARTBEAT, records frames via `record_frame_bg`. |

#### Serial / USB-CAN — [backend-py/serial_bridge.py](backend-py/serial_bridge.py)

| Method | Path | Purpose |
|---|---|---|
| GET | `/serial/ports` | List all COM ports from `pyserial` |
| GET | `/serial/detect` | Detect USB-CAN adapters (libusb for Waveshare VID 04D8:0053, WMI fallback, serial COM heuristics). Returns driver_ok, channel, description. |
| WS | `/ws/serial` | USB-CAN / serial bridge. First message: `{interface:"canalystii", channel, bitrate}` or `{interface:"serial", com_port, baud_rate}`. Streams CAN frames as `"200#0F"` text both ways; same RX parsing as TCP bridge. |

#### Config — [backend-py/config/routes.py](backend-py/config/routes.py)

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/config` | — | All configs: `{board_id → {board_name, output_names[15], input_names[4], timerPresets[], inputRules[]}}` |
| GET | `/config/{board_id}` | — | Single board config |
| POST | `/config` | `BoardConfigUpdate` | Upsert names; each optional field falls back to existing value |
| GET | `/timers/{board_id}` | — | Timer presets |
| POST | `/timers` | `TimerPresetCreate{board_id, name, outputs, enabled}` | Create timer, returns `{timer: {id, ...}}` |
| DELETE | `/timers/{timer_id}` | — | Soft-delete (sets `deletedAt`); nulls linked rules |
| PATCH | `/timers/{timer_id}/toggle` | — | Flip enabled flag |
| GET | `/rules/{board_id}` | — | Input rules |
| POST | `/rules` | `InputRuleCreate` | Create rule, optional `linked_timer_id` |
| DELETE | `/rules/{rule_id}` | — | Soft-delete |
| PATCH | `/rules/{rule_id}/toggle` | — | Flip enabled flag |
| POST | `/automation/linked` | `LinkedAutomationCreate` | "Both" wizard: create timer + rule linked in one call |

#### Logs (in-memory feed) — [backend-py/logs/routes.py](backend-py/logs/routes.py)

| Method | Path | Purpose |
|---|---|---|
| GET | `/logs` | In-memory ring buffer (1000 entries) filtered by `board_id`, `log_type`, `limit` |
| DELETE | `/logs` | Clear ring |

#### History (persisted) — [backend-py/history/routes.py](backend-py/history/routes.py)

All accept `days`, `start` (ISO), `end` (ISO), `limit`. Time window defaults to 1 day, max 30.

| Method | Path | Returns |
|---|---|---|
| GET | `/history/sensors` | JSON list of `SensorReading` rows (parsed byte arrays) |
| GET | `/history/sensors.csv` | CSV download `sensors_<board>_<start>_<end>.csv` |
| GET | `/history/frames` | JSON list of `CommLog` (raw CAN frames, tx/rx) |
| GET | `/history/frames.csv` | CSV download |
| GET | `/history/boardlogs` | JSON list of `BoardLog` (input/output transitions) |
| GET | `/history/boardlogs.csv` | CSV download |
| POST | `/history/prune?retain_days=30` | Hard-delete rows older than cutoff. Returns per-table delete counts. |

### Auxiliary Scripts

- **[backend-py/tcp_server.py](backend-py/tcp_server.py):** Multi-board TCP simulator (default 3 boards on :8001). Sends CREF REGISTER → STATUS + HEARTBEAT loop, responds to WRITE commands. Used in Docker `tcp-simulator` service.
- **[backend-py/udp_server.py](backend-py/udp_server.py):** UDP simulator — emits fake telemetry strings to registered bridges.
- **[backend-py/live_demo.py](backend-py/live_demo.py):** Seeds live demo data.
- **[backend-py/seed_demo_history.py](backend-py/seed_demo_history.py):** Seeds PostgreSQL with demo history rows.
- **[backend-py/migrate_sqlite_to_pg.py](backend-py/migrate_sqlite_to_pg.py):** One-shot migration from legacy `cangateway.db` SQLite to PostgreSQL.
- **Tests:** `test_bridge_bytes.py`, `test_bridge_reconnect.py`, `test_bridge_roundtrip.py`, `test_bridge_rx.py`, `test_e2e_postgres.py`, `test_history_e2e.py`, `test_frontend_persistence.mjs`.

### Python Dependencies ([backend-py/requirements.txt](backend-py/requirements.txt))

```
fastapi, uvicorn, pydantic, requests,
pyserial, python-can[canalystii], pyusb, libusb,
psycopg2-binary, python-dotenv
```

Prisma Client Python (`prisma` package + `prisma-client-py` generator) is installed separately via `prisma generate` against `backend-py/prisma/schema.prisma`.

---

## 3. Database (PostgreSQL via Prisma)

**Schema file:** [backend-py/prisma/schema.prisma](backend-py/prisma/schema.prisma)
**Provider:** `postgresql` via `env("DATABASE_URL")`
**Client:** `prisma-client-py` (asyncio interface, `recursive_type_depth = 5`)
**Soft-delete convention:** every mutable model has a nullable `deletedAt` column; queries filter `deletedAt: None` by default; hard-delete is reserved for the nightly prune job against the high-volume history tables.

### Models (9 total)

#### `Board` — live hardware registry
| Field | Type | Default / Notes |
|---|---|---|
| id | String | PK — `"192.168.2.2:5000"` or `"USB:CAN2"` |
| name | String | default "" |
| ip | String | default "" |
| port | Int | default 0 |
| status | String | `"online"` \| `"offline"` |
| lastSeen, createdAt | DateTime | default now |
| deletedAt | DateTime? | soft-delete |

Relations: 1-to-1 `config: BoardConfig`; 1-to-many `timerPresets`, `inputRules`, `logs (BoardLog)`, `commLogs`, `sensorData`, `connections`.

#### `BoardConfig` — per-board display/labels
| Field | Type | Default |
|---|---|---|
| id | Int autoincrement | PK |
| boardId | String | `@unique`, FK → Board.id ON DELETE CASCADE |
| boardName | String | default "" |
| outputNames | String[] | 15 custom names |
| inputNames | String[] | 4 custom names |
| updatedAt, deletedAt | DateTime | |

#### `TimerPreset` — scheduled output patterns
| Field | Type | Notes |
|---|---|---|
| id | Int | PK |
| boardId | String | FK → Board.id CASCADE |
| name | String | |
| outputs | Json | `[{outputIndex, onDelaySec, offDelaySec, onAuto, offAuto}, ...]` |
| durationSec | Int | default 0 |
| enabled | Bool | default true |
| createdAt/updatedAt/deletedAt | DateTime | |
| linkedRules | InputRule[] | back-relation |

#### `InputRule` — input-triggered automation
| Field | Type | Notes |
|---|---|---|
| id | Int | PK |
| boardId | String | FK CASCADE |
| name | String | |
| inputIndex | Int | 0–3 (DI1–DI4) |
| trigger | String | `"high"` \| `"low"` |
| actions | Json | `[{outputIndex, value}, ...]` |
| enabled | Bool | default true |
| linkedTimerId | Int? | FK → TimerPreset.id ON DELETE SET NULL |

#### `BoardLog` — input/output state transitions
| Field | Type | Notes |
|---|---|---|
| type | String | `"output"` \| `"input"` \| `"timer"` \| `"rule"` |
| index | Int | DO 0–14 / DI 0–3 |
| value | Bool | ON/OFF or HIGH/LOW |
| label | String | user-friendly name |
| timestamp | DateTime | |
| Indexes | | `@@index([boardId, timestamp])`, `@@index([boardId, type])` |

#### `CommLog` — raw CAN frames
`direction: "tx"|"rx"`, `rawFrame: "200#0B"`. Indexed on `(boardId, timestamp)` and `direction`.

#### `SensorReading` — parsed bytes per CAN ID
`canId: "200"`, `values: Json` (list of 0–255 ints). Indexed on `(boardId, canId, timestamp)`. Fed by the 1-row/second throttle.

#### `ConnectionHistory` — uptime tracking
`connectedAt`, `disconnectedAt?`, `reason?: "manual"|"timeout"|"error"`. Indexed on `(boardId, connectedAt)`.

#### `UserSettings` — simple key/value store
`key @unique`, `value: String` (JSON-encoded), `updatedAt`. Used for `theme`, `encoding`, `sensorDelimiter`, etc.

### Data-access layer — [backend-py/database.py](backend-py/database.py)

Wraps Prisma calls with:
- `_ensure_board(board_id)` — upsert-on-write (routes auto-create a Board row if missing)
- `save_/get_/delete_/toggle_` helpers for board config, timer presets, input rules
- `save_comm_log` / `get_frame_history`
- `save_sensor_reading` / `get_sensor_history`
- `save_board_log` / `get_board_log_history`
- `get_full_board_data(board_id)` — config + timers + rules aggregate
- `prune_history(retain_days=30)` — hard-delete on the three high-volume tables

---

## 4. Frontend (React + Vite)

### Bootstrap

- [src/main.tsx](src/main.tsx) mounts `<App />` into `#root`.
- [src/App.tsx](src/App.tsx) wraps: `QueryClientProvider → TcpProvider → BoardProvider → TooltipProvider → BrowserRouter → DashboardLayout → Routes`.

### Routes ([src/App.tsx](src/App.tsx))

| Path | Page | Responsibility |
|---|---|---|
| `/` | Dashboard | Live KPIs, traffic chart, I/O chart, activity feed |
| `/connect` | Connect | Pick TCP / UDP / USB-CAN; scan USB-CAN adapters via `/serial/detect` |
| `/board-control` | BoardControl | Per-board DO switches, DI indicators, raw-byte view, all-boards overview |
| `/board-config` | BoardConfig | Rename boards/IOs, create TimerPresets, InputRules, "Both" linked automation |
| `/send-data` | SendData | Normal send + traffic generator + CAN-Bus-Loader (encodes CAN frames manually) |
| `/server-monitor` | ServerMonitor | (Mock) CPU/GPU/memory chart, connection details table |
| `/logs` | Logs | Live TX/RX stream from `TcpContext.feed`, pause/filter/export TSV |
| `/board-logs` | CrefMessages | State-change history (from `BoardContext.logs`) |
| `/settings` | SettingsPage | Local-only prefs (IP defaults, auto-refresh, theme toggle) |

### Core State

#### [src/contexts/TcpContext.tsx](src/contexts/TcpContext.tsx) — transport layer

Owned state:
- `feed: Interaction[]` — 100-item sliding window of TX/RX frames
- `status: string` — human-readable connection state
- `activeEndpoint: {ip, port, protocol, comPort?, baudRate?}` — persisted to `localStorage` under `tcp.activeEndpoint`
- `rxCount`, `txCount` (lifetime counters), `rxFps`, `txFps` (ticked every 1 s)
- `isTauri` — detects `window.__TAURI_INTERNALS__`

Connect strategy:
- **Tauri + TCP/UDP:** invokes Rust `connect_to_server` command
- **Browser + TCP/UDP:** opens `ws://localhost:8000/ws/tcp`, first message `{ip, port, protocol}`
- **USB-CAN (always WS):** opens `ws://localhost:8000/ws/serial`, first message chooses `canalystii` (channel 0/1, bitrate) or `serial` (com_port, baud_rate)
- **Auto-reconnect:** on mount, if a saved endpoint exists in localStorage, call `connect()` once

Send strategy:
- `sendMessage(msg, displayAs?)` pushes a TX into the feed + counters
- In Tauri, invokes `send_to_server` / `send_bytes_to_server`
- In browser, sends through the WebSocket

#### [src/contexts/BoardContext.tsx](src/contexts/BoardContext.tsx) — application layer (central logic)

Heavy file. Responsibilities:

1. **Board registry sync** — polls `GET /boards` every 5 s, merges with in-memory state; sets outputs to all-off when a board goes offline.
2. **Auto-register on connect** — when `activeEndpoint` arrives, create a local `BoardData` at `${ip}:${port}` or `USB:${comPort}`.
3. **Input parsing** — on every new RX frame, decode `200#XX` into 4 booleans and update `boards[].inputs`.
4. **Rule evaluation** — on input edge, run all enabled `inputRules` with `edge-detection` (no repeat fires while level held). Fires immediate actions or schedules them through `linkedTimer` ON/OFF delays. Emits rule log entries.
5. **Timer engine** — 1 s `setInterval` decrements every `RunningTimer.remainingSec`; when a timer hits zero, its target value is applied and a CAN frame is sent. Auto-mode (`onAuto`/`offAuto`) chains a one-shot OFF phase after ON fires.
6. **Config persistence** — reads `/config` on mount, writes back on every update via `POST /config`, `POST /timers`, `POST /rules`, `DELETE /timers/:id`, `DELETE /rules/:id`, `PATCH /rules/:id/toggle`. Also mirrors to `localStorage` under `boards.configs` and `boards.logs` (last 500).
7. **Output commands** — `toggleOutput`, `writeOutputs` encode to `100#AABB` CAN frames via the TCP/WS writer (`sendMessage` from `TcpContext`); respect per-output timer delays.

Exposed API to pages:
```ts
{ boards, selectedBoardId, selectBoard, toggleOutput, writeOutputs,
  refreshBoards, connected, isDemo, logs, clearLogs,
  getConfig, updateConfig,
  addTimerPreset, removeTimerPreset, runAutoTimer, stopAutoTimer, runningTimers,
  addInputRule, removeInputRule, toggleInputRule }
```

#### [src/hooks/useTcpStream.ts](src/hooks/useTcpStream.ts)

Thin pass-through over `useTcp()` to keep page code clean.

### UI Components

- **[DashboardLayout](src/components/DashboardLayout.tsx)** + **[AppSidebar](src/components/AppSidebar.tsx)** — shadcn/ui collapsible sidebar with grouped navigation (Main / Control / Monitor / Settings) and a connection footer.
- **[TopNavbar](src/components/TopNavbar.tsx)**, **[NavLink](src/components/NavLink.tsx)**, **[ThemeToggle](src/components/ThemeToggle.tsx)**.
- **[CanBusLoader](src/components/CanBusLoader.tsx)** — manual CAN frame crafter used on the Send Data page.
- **[src/components/ui/](src/components/ui/)** — full shadcn/ui library (Radix-based): accordion, alert-dialog, avatar, button, card, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown, form, hover-card, input, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, switch, table, tabs, textarea, toast, toggle, tooltip.

### Build / Tooling

- **Scripts:** `dev` (Vite @ :8080), `build`, `build:dev`, `lint`, `preview`, `test` (vitest), `tauri`.
- **[vite.config.ts](vite.config.ts):** host `0.0.0.0:8080`, alias `@` → `./src`, Tauri `TAURI_PLATFORM`-aware build targets, React-SWC plugin, `lovable-tagger` in dev only.
- **Dependencies of note:** `@tanstack/react-query`, `react-router-dom`, `recharts`, `react-hook-form`, `zod`, `date-fns`, `jspdf`, `xlsx`, `html2canvas`, `sonner`, `lucide-react`, `@tauri-apps/api`.

---

## 5. Tauri Native Shell — [src-tauri/src/lib.rs](src-tauri/src/lib.rs)

Optional desktop wrapper. Provides four `#[tauri::command]`s:

| Command | Purpose |
|---|---|
| `connect_to_server(ip, port, protocol)` | Opens a `tokio::net::TcpStream` with 3 s timeout; splits into read/write halves; spawns reader task that emits `tcp-data` (hex payload) and `tcp-status` events to the webview |
| `send_to_server(message: String)` | Write UTF-8 text on the shared writer half |
| `send_bytes_to_server(data: Vec<u8>)` | Write raw bytes |
| `get_system_stats()` | Returns `"Live Socket System Active"` |

State is `Arc<Mutex<Option<OwnedWriteHalf>>>`. Reader task exits on EOF or error and emits `"Disconnected"`. UDP is currently a stub — Tauri native falls back to the Python WS bridge for non-TCP.

---

## 6. Deployment

### [docker-compose.yml](docker-compose.yml)

Two services built from the same `./backend-py` image:
- **backend** — runs `python main.py`, binds `:8000`
- **tcp-simulator** — runs `python tcp_server.py --boards 3 --port 8001`, binds `:8001`

### [backend-py/Dockerfile](backend-py/Dockerfile)

`python:3.11-slim`, installs `requirements.txt`, exposes `:8000`, default `CMD ["python", "run.py"]` (note: `run.py` is not in the repo — running the container needs either a `run.py` or an overridden command like `python main.py`).

---

## 7. Data Flow (end-to-end)

```
Hardware                                    Backend                              Frontend
────────                                    ───────                              ────────
CAN bus                                     FastAPI :8000                        React :8080
                                                                                 (or Tauri)

Board X  ─ 200#0F ─► TCP/USB-CAN bridge ─► parse can_id=200                      useTcpStream
                     /ws/tcp or /ws/serial   → board.inputs = [1,1,1,1]  ──WS──► feed / status
                                              record_frame_bg                    BoardContext
                                              log_state_bulk_bg                    ↓
                                              ws_manager.broadcast               rules eval
                                                                                   ↓
                                                                                 toggleOutput

User toggles DO3 ─────────────────── BoardContext.toggleOutput
                                           │
                                           ├─► encode 100#0400 ─ WS ─► writer.write() ─► Hardware
                                           └─► log_state_change_bg  ─► BoardLog row

Every 1 s                                  _prune_loop (only every 24 h)
                                           history_recorder throttles
                                           Prisma writes to Postgres

History download                      GET /history/frames.csv
                                      ?board_id=B1&days=7
                                                ▼
                                      Prisma find_many → CSV StreamingResponse
```

---

## 8. Working API — Quick Reference

```http
# Status
GET  /                              → {message}
GET  /status                        → {total_boards, online, offline}

# Boards
GET  /boards                        → [Board]
GET  /boards/{id}                   → Board
POST /toggle                        body: {board_id, output_index, value}
POST /send                          body: {board_id, outputs[15]}
WS   /ws/boards                     push: boards_list, board_update; cmd: toggle|write|refresh

# Transport bridges
WS   /ws/tcp                        first msg: {ip, port, protocol:"tcp"|"udp"}
WS   /ws/serial                     first msg: {interface:"canalystii"|"serial", ...}
GET  /serial/ports                  → list COM ports
GET  /serial/detect                 → list USB-CAN + driver status

# Config
GET    /config                      → {board_id: FullBoardData}
GET    /config/{board_id}           → FullBoardData
POST   /config                      body: BoardConfigUpdate
GET    /timers/{board_id}           → [TimerPreset]
POST   /timers                      body: TimerPresetCreate
DELETE /timers/{timer_id}
PATCH  /timers/{timer_id}/toggle
GET    /rules/{board_id}            → [InputRule]
POST   /rules                       body: InputRuleCreate
DELETE /rules/{rule_id}
PATCH  /rules/{rule_id}/toggle
POST   /automation/linked           body: LinkedAutomationCreate

# Logs (in-memory)
GET    /logs?board_id=&log_type=&limit=200
DELETE /logs

# History (Postgres)
GET  /history/sensors               ?board_id&can_id&days|start&end&limit
GET  /history/sensors.csv           same params → CSV download
GET  /history/frames                ?board_id&direction&days|start&end&limit
GET  /history/frames.csv
GET  /history/boardlogs             ?board_id&log_type&days|start&end&limit
GET  /history/boardlogs.csv
POST /history/prune?retain_days=30
```

---

## 9. Known Issues / Gotchas

- **[backend-py/Dockerfile](backend-py/Dockerfile)** CMD references `run.py` which does not exist — container as-written will fail; `docker-compose.yml` `tcp-simulator` overrides the command and works fine, but the `backend` service will exit immediately unless the image is rebuilt with `python main.py` or a `run.py` is added.
- **CORS wide open** (`allow_origins=["*"]`) — fine for development, should be narrowed in production.
- **[src/pages/Connect.tsx:26](src/pages/Connect.tsx#L26)** destructures `fps` from `useTcpStream()` but the hook exposes `rxFps` and `txFps`, not `fps` — the `{fps}` badge at line 261 will render `undefined`.
- **[src/pages/SettingsPage.tsx](src/pages/SettingsPage.tsx)** settings are local state only — `save()` only shows a toast, nothing is persisted.
- **ServerMonitor** metrics (CPU/GPU/memory) are `Math.random()` — no real telemetry source.
- **Retention job** runs every 24 h from startup; if the backend restarts frequently, pruning effectively runs at every startup.
- **SQLite leftover:** `backend-py/cangateway.db` exists in the tree from the pre-Postgres era; `migrate_sqlite_to_pg.py` is the one-time migration path.
- **history/recorder dedup maps** (`_last_frame_text`, `_last_sensor_ts`, `_last_state`) are unbounded in process memory — they grow with distinct `(board, direction, can_id)` or `(board, type, index)` tuples. In practice this is small, but worth noting for long-lived processes with many boards.

---

## 10. How to Run

```bash
# Backend (from repo root)
cd backend-py
pip install -r requirements.txt
prisma generate                          # generate Prisma Python client
# Set DATABASE_URL=postgresql://user:pass@localhost:5432/cangateway
prisma db push                           # create tables
python main.py                           # :8000

# (optional) TCP simulator
python tcp_server.py --boards 3 --port 8001

# Frontend
bun install                              # or npm install
bun run dev                              # :8080 → http://localhost:8080

# Tauri (optional desktop)
bun run tauri dev

# Docker
docker-compose up -d                     # backend :8000 + simulator :8001
                                         # (fix Dockerfile CMD first — see §9)
```
