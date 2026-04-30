# CANGateway — System Architecture

End-to-end explanation of the CANGateway dashboard: hardware, backend, database, frontend, and how every user action flows through the stack. Written for handoff to clients, new engineers, or anyone onboarding to the project.

**Document location**: `docs/System-Architecture.md` (this file)
**Companion doc**: `docs/CAN-Bus-Loader-Guide.md` (feature-specific)

---

## 1. High-level picture

```
  ┌──────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────┐
  │   HARDWARE LAYER     │     │     BACKEND (Python)    │     │  FRONTEND (React)   │
  │                      │     │                         │     │                     │
  │  CAN Boards (Dev1…N) │◄─►  │  FastAPI + Prisma       │◄─►  │  Vite dev server    │
  │  over CAN bus        │ CAN │  Port 8000              │ WS  │  Port 8080          │
  │                      │     │                         │     │                     │
  │  via USB-CAN-B or    │     │  Auto-detect devices    │     │  Dashboard          │
  │  TCP/UDP gateway     │     │  Persist history        │     │  Board Control      │
  │                      │     │  Broadcast state        │     │  Send Data / Logs   │
  └──────────────────────┘     └───────────┬─────────────┘     └─────────────────────┘
                                           │
                                           │  Prisma (SQL)
                                           ▼
                               ┌─────────────────────────┐
                               │  PostgreSQL (cangateway)│
                               │  9 tables + soft-delete │
                               │  30-day retention       │
                               └─────────────────────────┘
```

**Three tiers:**

| Tier | Tech | Role |
|---|---|---|
| Hardware | STM32-based CAN boards on a shared bus | Expose 15 digital outputs (DO1–DO15) and 4 digital inputs (DI1–DI4) per device. Talk over CAN at 500 kbps. |
| Backend | Python 3.11 + FastAPI + Prisma (Python) | Bridges CAN ↔ WebSocket, persists state + history, serves REST API, enforces retention. |
| Frontend | React 18 + TypeScript + Vite + TailwindCSS + Recharts + Tauri (optional native) | UI for monitoring, control, configuration, traffic generation, historical analysis. |
| Database | PostgreSQL 18 | Single source of truth for board configs, timers, rules, logs, sensor readings, comm logs. |

---

## 2. Hardware layer

### CAN frame convention (the protocol that makes multi-board work)

Every physical device on the bus uses a **pair of CAN IDs**:

| Device | Output control (RX by device) | Input status (TX by device) |
|---|---|---|
| Dev 1 | `0x100` — 2 bytes → 15 outputs | `0x200` — 1 byte → 4 inputs (every 100 ms) |
| Dev 2 | `0x101` — 2 bytes → 15 outputs | `0x201` — 1 byte → 4 inputs |
| Dev N | `0x10(N-1)` | `0x20(N-1)` |

**Byte layout — Output control (0x10N):**
```
Byte 0 (bits 0-7): DO1..DO8
Byte 1 (bits 0-6): DO9..DO15   (bit 7 unused)
```

**Byte layout — Input status (0x20N):**
```
Byte 0 (bits 0-3): DI1..DI4    (bits 4-7 unused)
```

**Example** — to turn DO1, DO3, DO6 ON for Device-1: send `100#1500`
(binary `00010101` → byte 0 = 0x15, byte 1 = 0x00)

### Physical connections supported

- **USB-CAN-B** adapter (Waveshare, VID 04D8:0053) via `python-can` with `canalystii` backend
- **Serial/COM (slcan)** via `pyserial` as a fallback
- **TCP/UDP gateway** for hardware reachable over IP

---

## 3. Backend (Python)

**Location**: [backend-py/](../backend-py/)
**Entry**: `python main.py` (runs uvicorn on :8000)

### Directory structure

```
backend-py/
├── main.py                # FastAPI app + lifecycle (DB connect, retention loop)
├── database.py            # Prisma async DB layer (all CRUD + queries)
├── history_recorder.py    # In-memory dedup + throttle for writes to history tables
├── protocol/
│   ├── cref.py            # Board dataclass, CAN encode/decode helpers
│   └── __init__.py
├── boards/
│   ├── service.py         # In-memory board registry + auto-detect logic
│   └── routes.py          # /boards, /toggle, /send, /ws/boards
├── connect/routes.py      # /ws/tcp — TCP/UDP bridge
├── serial_bridge.py       # /ws/serial — USB-CAN bridge
├── config/routes.py       # /config, /timers, /rules, /automation/linked
├── history/routes.py      # /history/sensors, /history/frames, /history/boardlogs + .csv
├── status/routes.py       # /ping, health endpoints
├── logs/routes.py         # legacy in-memory ring buffer
├── websocket/manager.py   # WebSocket fan-out broadcast (parallelized)
├── prisma/schema.prisma   # DB schema
└── .env                   # DATABASE_URL
```

### Responsibilities per module

| Module | What it does |
|---|---|
| [main.py](../backend-py/main.py) | Boots FastAPI, registers routers, connects Prisma on startup, runs `prune_history(30)` on startup and every 24h in a background task. |
| [database.py](../backend-py/database.py) | All DB reads/writes go through here — board configs, timers, rules, sensor readings, frame log, board log, history queries, retention prune. Every function is `async` and uses the Prisma client. |
| [boards/service.py](../backend-py/boards/service.py) | Owns the in-memory `board_registry` dict keyed by `{connection}:dev{N}`. Contains `detect_and_register()` — the heart of multi-board auto-detection. |
| [serial_bridge.py](../backend-py/serial_bridge.py) | WebSocket endpoint `/ws/serial`. Opens USB-CAN bus with `python-can`, spawns `can_to_ws` (RX loop) and `ws_to_can` (TX loop). On every RX frame, calls `detect_and_register`, updates board state, broadcasts. |
| [connect/routes.py](../backend-py/connect/routes.py) | WebSocket endpoint `/ws/tcp`. Same responsibilities as serial_bridge but for TCP/UDP hardware. |
| [boards/routes.py](../backend-py/boards/routes.py) | REST `/toggle`, `/send`; also `/ws/boards` for frontend to subscribe to board state updates. |
| [config/routes.py](../backend-py/config/routes.py) | Full CRUD for board configs (names), timer presets, input rules, linked automations. |
| [history/routes.py](../backend-py/history/routes.py) | `/history/sensors`, `/history/frames`, `/history/boardlogs` — JSON + `.csv` variants for downloads. `/history/prune` for manual retention. |
| [history_recorder.py](../backend-py/history_recorder.py) | In-memory dedup cache + 1-Hz sensor throttle. Frames that don't change aren't re-logged. Background-scheduled writes (non-blocking on the receive loop). |
| [websocket/manager.py](../backend-py/websocket/manager.py) | `ws_manager.broadcast()` fans out to all subscribed WS clients in parallel (`asyncio.gather`). |

### Key design properties

- **Non-blocking receive loops**: both `tcp_to_ws` and `can_to_ws` never `await` a DB write directly — history writes are fire-and-forget via `asyncio.create_task`.
- **Change-detection gate**: `update_board` only broadcasts when `new_inputs != board.inputs` (or outputs). Prevents WS flood when firmware sends unchanged frames at 55 Hz.
- **Fail-open history**: if Prisma is down, `record_frame_bg`/`log_state_bulk_bg` logs the error and returns — receive loop keeps running.
- **Auto-reconnect stance**: the frontend persists the `activeEndpoint` to localStorage and reconnects on page load.

---

## 4. Database (PostgreSQL + Prisma)

**Schema file**: [backend-py/prisma/schema.prisma](../backend-py/prisma/schema.prisma)
**Connection string**: `postgresql://postgres:root@localhost:5432/cangateway` (from `.env`)
**Migration command**: `prisma db push` (also auto-generates the Python client)

### Tables (9 total)

| Table | Purpose | Soft delete? | Retention |
|---|---|---|---|
| `Board` | One row per logical device. Composite id `"{connection}:dev{N}"`. Holds `outputCanId`, `inputCanId`, `deviceNumber`, `connection`. | Yes (`deletedAt`) | — |
| `BoardConfig` | Per-board custom names (DO1..DO15 labels, DI1..DI4 labels), board_name. 1:1 with `Board`. | Yes | — |
| `TimerPreset` | Named output sequences (on-delay, off-delay, auto). | Yes | — |
| `InputRule` | "When DI3 goes LOW, run these actions." Optionally linked to a `TimerPreset`. | Yes | — |
| `BoardLog` | Every input/output state *change* (dedup'd — not every frame). | — | **30 days** (hard-delete by prune) |
| `CommLog` | Raw CAN frames (dedup'd to one per change per (board, direction, canId)). | — | **30 days** |
| `SensorReading` | Downsampled sensor data — 1 row per (board, canId) per second, raw bytes preserved. | — | **30 days** |
| `ConnectionHistory` | Connect/disconnect uptime tracking. | — | **30 days** |
| `UserSettings` | Key-value global settings. | — | — |

### Soft-delete semantics

`Board`, `BoardConfig`, `TimerPreset`, `InputRule` all have a `deletedAt: DateTime?` column. "Delete" in the app sets `deletedAt = now()`; queries always filter `where: {deletedAt: null}`. Nothing is physically removed. Child relations (e.g. `TimerPreset.linkedRules`) remain intact because soft-deletes don't cascade.

### Retention (hard-delete)

[database.py:prune_history()](../backend-py/database.py) deletes rows older than `retain_days` (default 30) from `CommLog`, `SensorReading`, `BoardLog`. Run:
- Once on app startup
- Every 24 hours in a background `asyncio` loop
- Manually via `POST /history/prune?retain_days=N`

### Indexes

The three high-volume tables have composite indexes for time-range queries:
- `CommLog @@index([boardId, timestamp])`
- `SensorReading @@index([boardId, canId, timestamp])`
- `BoardLog @@index([boardId, timestamp])`, `@@index([boardId, type])`

---

## 5. Frontend (React/Vite)

**Location**: [src/](../src/)
**Entry**: `src/main.tsx` → Vite dev server at `http://localhost:8080`
**Native build**: Tauri (optional) in `src-tauri/`

### Directory structure

```
src/
├── main.tsx            # React root
├── App.tsx             # Router + providers (TcpProvider, BoardProvider)
├── pages/
│   ├── Dashboard.tsx       # Live overview (KPIs, per-board I/O timeline)
│   ├── Connect.tsx         # Pick protocol/IP/port or USB-CAN channel
│   ├── BoardControl.tsx    # Toggle outputs, see inputs live
│   ├── BoardConfiguration.tsx # Name outputs/inputs, timers, rules
│   ├── SendData.tsx        # Raw CAN send + receive + sensor graph + history
│   ├── ServerMonitor.tsx   # Backend health, endpoint, uptime
│   └── Logs.tsx            # Raw frame log with filters
├── contexts/
│   ├── TcpContext.tsx      # Owns the WebSocket connection + feed buffer
│   └── BoardContext.tsx    # Owns boards list, configs, timers, rules; parses RX frames; fires input rules
├── hooks/
│   └── useTcpStream.ts     # Thin wrapper around TcpContext
├── components/
│   ├── AppSidebar.tsx      # Left nav
│   ├── TopNavbar.tsx       # Header (theme, notifications)
│   ├── CanBusLoader.tsx    # Traffic generator dialog (CAN Loader)
│   └── ui/                 # shadcn/ui primitives
└── lib/utils.ts            # cn() and small helpers
```

### Contexts (where global state lives)

- **[TcpContext.tsx](../src/contexts/TcpContext.tsx)** — holds `feed` (ring buffer of last 100 frames), `activeEndpoint`, `rxCount`, `txCount`, `rxFps`, `txFps`. Exports `formatEndpoint(ep)` → `"192.168.2.2:5000"` for TCP or `"USB:CAN2 @ 500k"` for USB-CAN.
- **[BoardContext.tsx](../src/contexts/BoardContext.tsx)** — holds `boards` (list of logical devices with live state), `configs`, `timerPresets`, `inputRules`, `logs`. The RX-frame parser useEffect (line 339) turns incoming frames into state updates; handles Dev1..DevN by decoding `0x10N`/`0x20N`.

### How the frontend talks to the backend

- **REST**: `fetch("http://localhost:8000/...")` for CRUD (configs, timers, rules, history, toggle)
- **WebSocket frame bridge**: `ws://localhost:8000/ws/tcp` or `ws://localhost:8000/ws/serial` — every CAN frame that hits the bus arrives as a JSON `{message: <hex>, format: "hex", timestamp}` message
- **Auto-reconnect**: `readStoredEndpoint()` on mount → if a stored endpoint exists, reconnect automatically

---

## 6. Communication protocols

### REST endpoints (full list)

| Method | Path | Purpose |
|---|---|---|
| GET | `/boards` | List all logical devices (Dev1/Dev2/…) currently in registry |
| GET | `/boards/{id}` | Single board detail |
| POST | `/toggle` | `{board_id, output_index, value}` → flip one output |
| POST | `/send` | `{board_id, outputs[]}` → write all 15 outputs at once |
| GET | `/config` | All board configs with timers + rules |
| POST | `/config` | Update board name + output/input labels |
| GET/POST/DELETE | `/timers[/{id}]` | Timer preset CRUD |
| PATCH | `/timers/{id}/toggle` | Flip `enabled` flag |
| GET/POST/DELETE | `/rules[/{id}]` | Input rule CRUD |
| POST | `/automation/linked` | Create linked timer+rule ("Both" option) |
| GET | `/history/sensors[.csv]` | Sensor history over time range |
| GET | `/history/frames[.csv]` | Raw CAN frame history |
| GET | `/history/boardlogs[.csv]` | Input/output state-change history |
| POST | `/history/prune?retain_days=N` | Force retention cleanup |

### WebSocket endpoints

| Path | Direction | Payload |
|---|---|---|
| `/ws/tcp` | both | TCP/UDP bridge. Client sends `{ip, port, protocol}` as first message. Server streams frames. |
| `/ws/serial` | both | USB-CAN bridge. Client sends `{comPort, baudRate, channel}` as first message. |
| `/ws/boards` | server → client | Broadcasts `{type: "boards_list"\|"board_update", ...}` on state changes. |

---

## 7. End-to-end flows

### Flow A — Connecting to hardware

```
 User on /connect page
       │  clicks "Connect" (USB-CAN / TCP)
       ▼
 TcpContext.connect(ip, port, protocol, comPort, baudRate)
       │  localStorage.setItem('tcp.activeEndpoint', ...)
       ▼
 new WebSocket('ws://localhost:8000/ws/serial' or '/ws/tcp')
       │  first message: {ip, port, protocol, comPort, ...}
       ▼
 Backend serial_bridge.py or connect/routes.py
       │  opens python-can bus or asyncio.open_connection
       │  calls register_board(connection, device_number=1, ...)
       │  spawns 2 tasks: rx-loop + tx-loop
       ▼
 First frame arrives from hardware
       │  detect_and_register picks up CAN ID → determines device #
       │  auto-registers missing devices in board_registry
       ▼
 board_update broadcast via ws_manager (to /ws/boards)
 frame forwarded via /ws/serial (to TcpContext.feed)
       ▼
 Frontend UI shows connection online + board list
```

### Flow B — Toggling an output (click DO3 ON)

```
 User on /board-control clicks DO3 toggle
       ▼
 BoardContext.toggleOutput(boardId, 2, true)
       │  fetch POST http://localhost:8000/toggle
       ▼
 Backend boards/routes.py::toggle_output
       │  board = registry.get(boardId)
       │  board.outputs[2] = true
       │  log_state_change_bg('output', 2, true, 'DO3')   → BoardLog (if changed)
       │  frame = f"{board.output_can_id}#{encode_outputs(board.outputs)}"
       │  writer = writer_for(board)  → shared connection writer
       │  writer.write(frame + "\n")
       │  record_frame_bg('tx', frame) → CommLog (if changed)
       │  update_board(board) → broadcast to /ws/boards
       ▼
 Hardware (board)
       │  CAN ID 0x100 (or 0x10N for DevN) received
       │  applies output mask to GPIOs
       │  eventually sends input-status 0x200 back
       ▼
 Backend receive loop picks up the response
       │  updates registry, broadcasts
       ▼
 Frontend button animates to ON
```

### Flow C — Input pin changes on hardware

```
 Physical switch wired to DI2 is flipped HIGH
       ▼
 Firmware reads GPIO, builds 0x201 frame (Dev2 input status)
       │  sends on CAN bus (every 100 ms + on change if interrupt-driven)
       ▼
 USB-CAN adapter hands frame to python-can
       ▼
 serial_bridge.py::can_to_ws
       │  msg.arbitration_id = 0x201, data = [0x02]
       │  detect_and_register('USB:CAN2', '201') → Dev2
       │  new_inputs = [F, T, F, F]
       │  if new_inputs != board.inputs:   ← THE KEY OPTIMIZATION
       │      board.inputs = new_inputs
       │      log_state_bulk_bg('input', ...) → BoardLog
       │      await update_board(board) → broadcast /ws/boards
       │  (always) record_frame_bg to CommLog if frame text changed
       ▼
 Frontend
       │  TcpContext receives WS message → appends to feed
       │  BoardContext parser useEffect (line 339) fires:
       │    cidNum = 0x201 → devNum = 2, boardId = 'USB:CAN2:dev2'
       │    decodes byte → [F,T,F,F]
       │    setBoards(...) only if actually changed
       ▼
 BoardControl page: DI2 indicator flips GREEN in <25 ms
```

### Flow D — Multi-board auto-detection

```
 Hardware: two boards on the same bus
   Dev1 sends 0x100 / 0x200
   Dev2 sends 0x101 / 0x201
       ▼
 Backend receives first 0x200 → detect_and_register:
   cid_num = 0x200 → dev_num = 1, kind = "input"
   board_id = "USB:CAN2:dev1"
   not in registry → register_board(connection, 1, outputCanId='100', inputCanId='200')
       ▼
 Backend receives first 0x201 → detect_and_register:
   dev_num = 2, kind = "input"
   board_id = "USB:CAN2:dev2"
   not in registry → register_board(connection, 2, outputCanId='101', inputCanId='201')
       ▼
 Both boards appear independently in:
   - /boards response
   - /ws/boards broadcast
   - Board dropdown on frontend
   - Dashboard KPIs
       ▼
 Clicking Dev2's DO5:
   fetch /toggle {board_id: 'USB:CAN2:dev2', output_index: 4, value: true}
   frame built = f"{board.output_can_id}#..." = "101#1000" (NOT 100#)
   sent on the shared connection writer
```

### Flow E — Historical query + CSV download

```
 User on SendData page, in History mode
   selects board = USB:CAN2:dev1
   selects days = 5
   clicks Load
       ▼
 fetch /history/sensors?board_id=...&days=5
       ▼
 Backend history/routes.py::sensors_history
   s,e = now-5d, now
   rows = await db.sensorreading.find_many(where={boardId, timestamp: {gte:s, lte:e}}, take=50000)
   returns {count, rows: [{timestamp, can_id, values:[11,0,0,...]}]}
       ▼
 Frontend
   setHistoryRows(rows)
   sensorPoints useMemo parses rows → chart points (bytesPerSensor grouping)
   chart re-renders with historical data
       ▼
 User clicks "Sensors.csv" → window.open('/history/sensors.csv?...')
       ▼
 Backend streams CSV with headers
   Content-Disposition: attachment; filename="sensors_USB:CAN2:dev1_2026-04-18_2026-04-23.csv"
       ▼
 Browser saves file
```

### Flow F — Timer rule firing (input triggers output sequence)

```
 Config set up by user:
   Timer "Tank fill" outputs: DO4 ON 2s, OFF 3s
   Rule "Start fill on button": input=DI1, trigger="low", linkedTimerId=X
       ▼
 Hardware button pressed → DI1 goes LOW
       ▼
 Backend flow C above fires → board.inputs[0] = False (low)
       ▼
 Frontend BoardContext rule evaluator useEffect detects:
   - inputsChanged = true at index 0
   - rule.trigger = "low", newVal = false → match
   - executeRule(rule, boardId, linkedTimerId)
       ▼
 BoardContext runs linked timer (or rule.actions):
   for each output step:
     toggleOutput(boardId, idx, value) → POST /toggle
     setTimeout next step
```

---

## 8. Running the stack locally

Prerequisites: Python 3.11, Node 18+ (bun or npm), PostgreSQL running on localhost:5432.

```bash
# --- one-time setup ---
createdb cangateway                                # create PG database
cd backend-py
pip install -r requirements.txt
prisma generate && prisma db push                  # generate client + push schema
python migrate_sqlite_to_pg.py                     # (optional) migrate legacy SQLite data

# --- run backend ---
cd backend-py
python main.py                                     # uvicorn on :8000 with --reload

# --- run frontend ---
cd bubble-monitor-dashboard-main
bun install  (or: npm install)
bun run dev  (or: npm run dev)                    # Vite on :8080
```

Then open `http://localhost:8080` → Connect page → pick USB-CAN or TCP.

---

## 9. Tests

All inside `backend-py/`:

| Test | What it covers |
|---|---|
| `python test_e2e_postgres.py` | Board config + timers + soft-delete over live HTTP + PG |
| `python test_history_e2e.py` | Sensor/frame/boardlog history, range queries, CSV download, retention prune (22 checks) |
| `python test_multiboard.py` | Multi-board auto-detection + per-board TX routing (24 checks) |

Run them anytime — they seed and clean up their own test rows.

---

## 10. Quick reference — file → purpose

| What you want to change | Go here |
|---|---|
| CAN ID convention / multi-board logic | [backend-py/boards/service.py](../backend-py/boards/service.py) |
| How frames are parsed from hardware | [backend-py/serial_bridge.py](../backend-py/serial_bridge.py) + [backend-py/connect/routes.py](../backend-py/connect/routes.py) |
| How outputs are sent to hardware | [backend-py/boards/routes.py](../backend-py/boards/routes.py) |
| DB schema | [backend-py/prisma/schema.prisma](../backend-py/prisma/schema.prisma) |
| Retention policy | `RETENTION_DAYS` in [backend-py/main.py](../backend-py/main.py) |
| Sensor throttle / dedup | `SENSOR_THROTTLE_SEC` in [backend-py/history_recorder.py](../backend-py/history_recorder.py) |
| Frontend WebSocket / frame parsing | [src/contexts/TcpContext.tsx](../src/contexts/TcpContext.tsx) + [src/contexts/BoardContext.tsx](../src/contexts/BoardContext.tsx) |
| Dashboard cards / KPIs | [src/pages/Dashboard.tsx](../src/pages/Dashboard.tsx) |
| Send Data / Sensor Graph / History UI | [src/pages/SendData.tsx](../src/pages/SendData.tsx) |
| Timer / Rule config | [src/pages/BoardConfiguration.tsx](../src/pages/BoardConfiguration.tsx) + [backend-py/config/routes.py](../backend-py/config/routes.py) |
| Branding / favicon / meta | [index.html](../index.html) + [public/](../public/) |

---

## 11. Glossary

- **Logical board** — a single physical CAN device, identified by id `"{connection}:dev{N}"`
- **Connection** — the shared bus/wire (e.g. `"USB:CAN2"` or `"192.168.2.2:5000"`)
- **CAN ID pair** — the `(outputCanId, inputCanId)` tuple unique per device on a bus (e.g. `0x100/0x200`)
- **Frame dedup** — `CommLog` skips writing when `(board, direction, canId, rawFrame)` matches the previous one
- **Sensor throttle** — `SensorReading` caps writes at 1 row per (board, canId) per second
- **State-change gate** — `update_board` broadcast only fires when `new_state != current_state`
- **Soft delete** — set `deletedAt`, keep row; queries exclude via `where: {deletedAt: null}`
- **Hard delete** — physical `DELETE FROM` — only done by `prune_history` on CommLog/SensorReading/BoardLog older than retention

---

*For questions, start with the file map in §10.*
