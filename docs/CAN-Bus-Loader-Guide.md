# CAN Bus Loader - Complete Guide

## What is CAN Bus Loader?

CAN Bus Loader is a **traffic generator tool** built into your CANGateway dashboard. It sends CAN bus frames to your connected device (via TCP or USB-CAN) at configurable speeds, patterns, and data payloads.

Think of it like a **stress tester** or **simulator** for your CAN bus — you can flood the bus with messages, scan through all IDs, or simulate sensor data.

---

## Where to Find It

The CAN Bus Loader is a **popup dialog** accessible from **any page** in the dashboard.

**Location:** Top navigation bar > **"CAN Loader"** button (with lightning bolt icon)

```
+----------------------------------------------------------+
|  [=] | System Online        [CAN Loader] [theme] [bell]  |  <-- HERE
+----------------------------------------------------------+
```

When a loader is running, the button **pulses yellow** and shows how many are active.

---

## Prerequisites

Before using the CAN Bus Loader, you must:

1. Go to the **Connect** page
2. Connect to your device (TCP endpoint or USB-CAN)
3. Make sure the status shows **"Streaming"** or **"Connected"**

If not connected, the **Start** button will be disabled.

---

## Tab-by-Tab Explanation

The loader popup has **5 tabs**: Rate, Count, Id, Data, and Options.

---

### Tab 1: Rate

Controls **how fast** and **how many messages per burst** are sent.

#### Interval (ms)

This is the **delay between each burst** of messages.

| Option | Description |
|--------|-------------|
| **Constant** | Same delay every time. Example: `1 ms` = fires every 1 millisecond |
| **Random** | Random delay between min and max. Example: `50 to 200 ms` |

#### Burst Size (messages)

How many CAN frames to send in **one burst** (before waiting for the next interval).

| Option | Description |
|--------|-------------|
| **Constant** | Always send exactly N messages per burst |
| **Random** | Send between min and max messages per burst |

#### Examples

**Example 1: Fast constant load**
```
Interval: Constant = 1 ms
Burst:    Constant = 1
```
Result: Sends 1 message every 1ms = ~1000 messages/second

**Example 2: Realistic traffic simulation**
```
Interval: Random = 10 to 50 ms
Burst:    Constant = 3
```
Result: Every 10-50ms (random), sends 3 messages back-to-back. Simulates bursty real-world CAN traffic.

**Example 3: Heavy stress test**
```
Interval: Constant = 1 ms
Burst:    Random = 5 to 10
```
Result: Every 1ms, sends 5-10 messages. Very high load (~5000-10000 msg/sec).

---

### Tab 2: Count

Controls **how many total messages** to send before stopping.

| Option | Description |
|--------|-------------|
| **Fixed to N message(s)** | Automatically stops after sending exactly N messages. Shows a progress bar. |
| **Continuous transmission** | Runs forever until you manually click **Stop**. |

#### Examples

**Example 1: Send exactly 100 test messages**
```
Count: Fixed to 100 message(s)
```
Result: Loader starts, sends 100 frames, then auto-stops. You'll see a progress bar filling up.

**Example 2: Continuous monitoring test**
```
Count: Continuous transmission
```
Result: Keeps sending until you press Stop. Good for long-running stress tests.

---

### Tab 3: Id

Controls the **CAN Identifier** (the address part of each CAN frame).

#### CAN Identifier Range

| Field | Description |
|-------|-------------|
| **Lowest** | Minimum CAN ID (decimal). Default: `0` |
| **Highest** | Maximum CAN ID (decimal). Default: `2047` (max for 11-bit standard) |

#### ID Generation Mode

| Option | Description |
|--------|-------------|
| **Random** | Each frame gets a random ID between Lowest and Highest |
| **Scan from Lowest to Highest** | IDs go sequentially: 0, 1, 2, 3, ... 2047, 0, 1, 2, ... (cycles) |

#### Extended (29-bit) Identifiers

| Option | Description |
|--------|-------------|
| **Unchecked** | Standard 11-bit CAN IDs (0 to 2047). ID shown as 3 hex digits: `100`, `7FF` |
| **Checked** | Extended 29-bit CAN IDs (0 to 536870911). ID shown as 8 hex digits: `1ABCDEF0` |

#### CAN FD (Flexible Data Rate)

CAN FD is an extension of CAN that allows **higher data rates** and **larger payloads** (up to 64 bytes).

| Option | Description |
|--------|-------------|
| **FDF** | Enable CAN FD format. Appends `[FD]` flag to the frame |
| **BRS** | Bit Rate Switch — data phase runs at a higher bit rate. Appends `[FD+BRS]` |
| **Randomize CAN FD flags** | Randomly toggle FD and BRS on/off per frame |

#### Channel

Select which CAN channel to use (for multi-channel adapters like USBCAN2):

| Option | Description |
|--------|-------------|
| **CAN 1** | Send on channel 1 (default) |
| **CAN 2** | Send on channel 2 |

#### Examples

**Example 1: Test a specific device at ID 0x100**
```
Lowest:  256  (0x100 in decimal)
Highest: 256
Mode:    Random (doesn't matter since Lowest = Highest)
Extended: unchecked
```
Result: Every frame has ID `100`.
Frame: `100#0000000000000000`

**Example 2: Scan all standard CAN IDs**
```
Lowest:  0
Highest: 2047
Mode:    Scan from Lowest to Highest
Extended: unchecked
```
Result: Frames go 000, 001, 002, ... 7FF, 000, 001, ...
Frames:
```
000#0000000000000000
001#0000000000000001
002#0000000000000002
...
7FF#00000000000007FF
000#0000000000000800   (wraps around, counter keeps going)
```

**Example 3: Random extended IDs**
```
Lowest:  0
Highest: 536870911
Mode:    Random
Extended: checked
```
Result: Random 29-bit IDs like `1ABCDEF0`, `00001234`, `1FFFFFFF`
Frame: `1ABCDEF0#DEADBEEF01020304`

**Example 4: CAN FD with BRS**
```
Lowest:  256
Highest: 512
Mode:    Random
FDF:     checked
BRS:     checked
```
Result: Frames with FD flag and bit rate switch
Frame: `1A3#0102030405060708 [FD+BRS]`

---

### Tab 4: Data

Controls the **payload** (data bytes) in each CAN frame.

#### Length (DLC - Data Length Code)

How many data bytes per frame.

| Standard CAN | CAN FD |
|--------------|--------|
| 0 to 8 bytes | 0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64 bytes |

#### Random Length

| Option | Description |
|--------|-------------|
| **Unchecked** | Every frame has exactly the selected length |
| **Checked** | Each frame gets a random length from 0 up to the selected length |

#### Data Content Mode

| Option | Description |
|--------|-------------|
| **Message number in data part** | Data = incrementing counter. Frame 0 = `0000...`, Frame 1 = `0001...`, Frame 255 = `00FF...` |
| **Random data** | Each byte is a random hex value (00-FF) |

#### Examples

**Example 1: 8-byte frames with message counter**
```
Length:      8
Random len: unchecked
Data mode:  Message number in data part
```
Result (first 5 frames):
```
100#0000000000000000    (message #0)
100#0000000000000001    (message #1)
100#0000000000000002    (message #2)
...
100#00000000000000FF    (message #255)
100#0000000000000100    (message #256)
```
This is useful for **detecting lost or out-of-order frames** — if you see 0003 then 0005, you know frame 0004 was lost.

**Example 2: Random data, random length**
```
Length:      8
Random len: checked
Data mode:  Random data
```
Result:
```
100#A3                        (1 byte)
100#F2E1C8                    (3 bytes)
100#0B1C2D3E4F5A6B7C          (8 bytes)
100#9E                        (1 byte)
100#DEADBE                    (3 bytes)
```
Each frame has 0-8 random bytes. Good for **stress testing** CAN parsers with unexpected lengths.

**Example 3: Fixed 2-byte payload**
```
Length:      2
Random len: unchecked
Data mode:  Message number in data part
```
Result:
```
100#0000
100#0001
100#0002
...
100#FFFF
100#0000   (wraps around after 65535)
```

---

### Tab 5: Options

This tab shows a **read-only summary** of all your current settings and a **frame preview**.

| Field | Shows |
|-------|-------|
| State | Running or Stopped |
| Messages sent | Live counter |
| ID Mode | Random or Scan (with range) |
| Data Mode | Msg Counter or Random |
| CAN FD | Classic, FD, or FD + BRS |
| Extended ID | 11-bit or 29-bit |
| Channel | CAN 1 or CAN 2 |
| Frame Preview | Example of what the generated frame looks like |

---

## Multiple Loader Instances

You can run **multiple loaders simultaneously**, each with completely independent settings.

### How to Add

Click the **+** button next to the loader tabs at the top of the popup.

### How to Remove

Click the **trash icon** next to the loader name. A loader cannot be removed while running.

### How to Rename

Click on the loader name field and type a new name.

### Use Cases

**Use Case 1: Simulate two ECUs**
```
Loader 1: "Engine ECU"
  - ID: Fixed 0x100 (256)
  - Rate: 10ms
  - Data: Message counter, 8 bytes

Loader 2: "Brake ECU"
  - ID: Fixed 0x200 (512)
  - Rate: 20ms
  - Data: Random, 4 bytes
```
Both run at the same time, simulating two devices on the bus.

**Use Case 2: Stress test + monitor**
```
Loader 1: "Stress Test"
  - ID: Random 0-2047
  - Rate: 1ms
  - Burst: 10
  - Data: Random

Loader 2: "Heartbeat"
  - ID: Fixed 0x700 (1792)
  - Rate: 1000ms
  - Data: Counter
```
Heavy random load + a 1-second heartbeat to check the bus is still alive.

---

## Complete Workflow Examples

### Example A: Basic Device Test

**Goal:** Send 100 messages to your relay board at ID 0x100 and verify it responds.

```
Tab: Rate
  Interval: Constant = 100 ms
  Burst: Constant = 1

Tab: Count
  Fixed to 100 message(s)

Tab: Id
  Lowest: 256    (0x100)
  Highest: 256
  Mode: Random
  Extended: unchecked

Tab: Data
  Length: 2
  Random length: unchecked
  Data mode: Message number in data part
```

**What happens:**
1. Click Start
2. Every 100ms, sends one frame: `100#0000`, `100#0001`, `100#0002`, ...
3. After 100 messages, auto-stops
4. Check the Live Stream on Send Data page to see if your device responded
5. Total time: ~10 seconds

### Example B: Full Bus Scan

**Goal:** Scan all 2048 standard CAN IDs to discover what devices respond.

```
Tab: Rate
  Interval: Constant = 5 ms
  Burst: Constant = 1

Tab: Count
  Fixed to 2048 message(s)

Tab: Id
  Lowest: 0
  Highest: 2047
  Mode: Scan from Lowest to Highest
  Extended: unchecked

Tab: Data
  Length: 8
  Random length: unchecked
  Data mode: Message number in data part
```

**What happens:**
1. Click Start
2. Sends: `000#...`, `001#...`, `002#...`, ... `7FF#...`
3. Auto-stops after 2048 messages
4. Watch the RX panel — any responses indicate a device at that ID
5. Total time: ~10 seconds

### Example C: CAN FD Stress Test

**Goal:** Maximum throughput CAN FD test with 64-byte payloads.

```
Tab: Rate
  Interval: Constant = 1 ms
  Burst: Constant = 5

Tab: Count
  Continuous transmission

Tab: Id
  Lowest: 0
  Highest: 2047
  Mode: Random
  Extended: unchecked
  FDF: checked
  BRS: checked

Tab: Data
  Length: 64
  Random length: unchecked
  Data mode: Random data
```

**What happens:**
1. Click Start
2. Every 1ms, sends 5 frames with random IDs, 64 random bytes, CAN FD + BRS
3. ~5000 frames/second, each with 64 bytes = massive bus load
4. Runs until you click Stop
5. Monitor Server Monitor page for throughput stats

### Example D: Input Trigger Test

**Goal:** Send input state changes to test your board's input detection.

The board reads inputs from CAN ID `200` (hex). Bit 0 = Input 1, Bit 1 = Input 2, etc.

```
Tab: Rate
  Interval: Constant = 1000 ms
  Burst: Constant = 1

Tab: Count
  Continuous transmission

Tab: Id
  Lowest: 512    (0x200 in decimal)
  Highest: 512
  Mode: Random

Tab: Data
  Length: 1
  Random length: unchecked
  Data mode: Message number in data part
```

**What happens:**
1. Sends `200#00`, `200#01`, `200#02`, `200#03`, ...
2. `200#01` = Input 1 HIGH
3. `200#03` = Input 1 + Input 2 HIGH
4. `200#0F` = All 4 inputs HIGH
5. Watch Board Control page — inputs should toggle as the counter changes

---

## Frame Format Reference

Every frame sent by the loader follows this format:

```
ID#DATA[flags]\n

Where:
  ID    = Hex CAN identifier (3 digits standard, 8 digits extended)
  #     = Separator
  DATA  = Hex data bytes (2 hex chars per byte)
  flags = Optional: [FD] or [FD+BRS]
  \n    = Newline terminator
```

### Standard CAN Examples
```
100#0102          ID=0x100, 2 bytes: 01 02
7FF#DEADBEEF      ID=0x7FF, 4 bytes: DE AD BE EF
000#00            ID=0x000, 1 byte:  00
100#0102030405060708   ID=0x100, 8 bytes (max for standard CAN)
```

### Extended ID Examples
```
1ABCDEF0#0102     29-bit ID=0x1ABCDEF0, 2 bytes
00000100#AABB     29-bit ID=0x100, 2 bytes (same ID, but using extended format)
```

### CAN FD Examples
```
100#0102030405060708090A0B0C0D0E0F [FD]        FD frame, 16 bytes
100#0102030405060708090A0B0C0D0E0F [FD+BRS]    FD frame with Bit Rate Switch
```

---

## Status Indicators

| Indicator | Meaning |
|-----------|---------|
| Navbar button normal | No loaders running |
| Navbar button **yellow pulsing** | At least one loader is active |
| Navbar badge **"2 active"** | 2 loader instances currently running |
| Green dot on loader tab | That specific loader is running |
| Green status bar with counter | Shows live sent count |
| Progress bar | Shows completion % (only for Fixed count) |
| Toast "started" | Loader began transmitting |
| Toast "stopped - N sent" | Loader finished, shows total sent |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Start button is disabled | Connect to a device first (Connect page) |
| No messages appearing | Check the Live Stream on Send Data page |
| Messages sent but no response | Verify the CAN ID matches your device |
| Very slow sending | Reduce interval, increase burst size |
| Browser becomes slow | Reduce burst size or increase interval. Too many messages flood the UI feed |
| Loader auto-stopped | Count was set to Fixed — switch to Continuous |
