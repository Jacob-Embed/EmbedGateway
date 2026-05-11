"""
Virtual-board simulator for OTA demo mode.

Speaks the host-side OTA protocol back to the controller so the full
INIT_STEP1 → REBOOT_WAIT → INIT_STEP2 → STARTING → STREAMING → ENDING →
VERIFYING → APPLYING → COMPLETE state machine runs to success without any
real STM32 firmware on the bus.

Used only when the OTA session config sets `interface=virtual`. Both the
simulator and the OTA controller open `can.Bus(interface="virtual",
channel="hercules_demo")` — python-can's virtual backend is in-process and
delivers frames to every Bus instance sharing the same channel.

The simulator pretends to be one Hercules board with NodeID=1, replies on
0x581, accumulates DATA chunks on 0x6FF, computes CRC-16-CCITT over the
received image, and matches it against the CRC the controller sends in
the VERIFY unicast — so a real CRC mismatch (e.g. corrupted firmware)
would still be caught.
"""

from __future__ import annotations

import asyncio
import struct
from typing import Optional

try:
    import can
    HAS_CAN = True
except ImportError:
    HAS_CAN = False


VIRTUAL_INTERFACE = "virtual"
VIRTUAL_CHANNEL = "hercules_demo"

# Match the constants the controller uses (re-imported here so this module
# stands alone without circular imports).
CAN_ID_BROADCAST     = 0x600
CAN_ID_DATA          = 0x6FF
CAN_ID_RESPONSE_BASE = 0x580

CMD_INIT    = 0x01
CMD_START   = 0x02
CMD_END     = 0x03
CMD_ABORT   = 0x04
CMD_VERIFY  = 0x05
CMD_APPLY   = 0x06

STATUS_OK = 0x00

# Simulator parameters
SIM_NODE_ID = 1
SIM_HW_TYPE = 0x01
SIM_APP_FW_VER  = 0x0102   # v1.2 — running app version reported in step1
SIM_BL_FW_VER   = 0x0001   # v0.1 — bootloader version reported in step2
DATA_BYTES_PER_CHUNK = 6
ACK_EVERY = 64


def _crc16_ccitt(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= (b << 8) & 0xFFFF
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc


async def run_virtual_board(stop: asyncio.Event, log=lambda msg: None) -> None:
    """
    Run a single-board simulator until `stop` is set.

    Lifecycle:
      1. Idle, waiting on 0x600. Receive INIT broadcast → reply on 0x580+1
         with [INIT, OK, hw, fw_lo, fw_hi].
      2. Receive INIT broadcast a second time (after the host's REBOOT_WAIT)
         → reply same shape but with bootloader version.
      3. Receive START broadcast (with total_chunks payload) → reply with
         [START, OK]. Begin accumulating DATA chunks.
      4. For every chunk on 0x6FF: append to in-memory image. On every 64
         chunks reply on 0x580+1 with [END(0x03 — used as DATA_ACK channel),
         OK, last_idx_lo, last_idx_hi].
      5. Receive END broadcast → no reply needed.
      6. Receive VERIFY unicast (0x600+1) with CRC16 payload → compute
         CRC-16-CCITT over received image, compare, reply on 0x580+1 with
         [VERIFY, OK or ERROR].
      7. Receive APPLY unicast → reply with [APPLY, OK]. End.
    """
    if not HAS_CAN:
        log("python-can not available — virtual sim disabled")
        return

    bus = can.Bus(interface=VIRTUAL_INTERFACE, channel=VIRTUAL_CHANNEL)
    log(f"virtual board #{SIM_NODE_ID} online (interface=virtual, channel={VIRTUAL_CHANNEL})")

    image = bytearray()
    expected_chunks: Optional[int] = None
    init_count = 0
    chunks_received = 0
    last_chunk_idx = -1

    def reply(cmd: int, status: int, payload: bytes = b"") -> None:
        msg = can.Message(
            arbitration_id=CAN_ID_RESPONSE_BASE + SIM_NODE_ID,
            data=bytes([cmd, status]) + payload,
            is_extended_id=False,
        )
        bus.send(msg)

    loop = asyncio.get_event_loop()
    try:
        while not stop.is_set():
            # Use the executor so bus.recv() doesn't block the event loop.
            msg = await loop.run_in_executor(None, lambda: bus.recv(timeout=0.1))
            if msg is None:
                continue

            arb = msg.arbitration_id
            data = bytes(msg.data[:msg.dlc]) if hasattr(msg, "dlc") and msg.dlc else bytes(msg.data)

            # ── DATA chunk ──
            if arb == CAN_ID_DATA and len(data) >= 2:
                idx = struct.unpack_from("<H", data, 0)[0]
                payload = data[2:]
                chunks_received += 1
                last_chunk_idx = idx
                # Naive accumulator — append ordered. For a real simulator we'd
                # honour the index for out-of-order frames; the controller
                # streams in-order so this is fine for the demo.
                image.extend(payload)
                if chunks_received % ACK_EVERY == 0:
                    reply(CMD_END, STATUS_OK, struct.pack("<H", idx))   # piggy-back ACK on END cmd byte
                continue

            # ── Broadcast control ──
            if arb == CAN_ID_BROADCAST and data:
                cmd = data[0]
                if cmd == CMD_INIT:
                    init_count += 1
                    if init_count == 1:
                        # Step 1: app responds with hw + app fw version
                        reply(CMD_INIT, STATUS_OK,
                              bytes([SIM_HW_TYPE]) + struct.pack("<H", SIM_APP_FW_VER))
                        log(f"  virtual #{SIM_NODE_ID}: step1 reply (app v{SIM_APP_FW_VER:#06x})")
                    else:
                        # Step 2: pretend we rebooted into bootloader
                        reply(CMD_INIT, STATUS_OK,
                              bytes([SIM_HW_TYPE]) + struct.pack("<H", SIM_BL_FW_VER))
                        log(f"  virtual #{SIM_NODE_ID}: step2 reply (bl v{SIM_BL_FW_VER:#06x})")
                elif cmd == CMD_START and len(data) >= 3:
                    expected_chunks = struct.unpack_from("<H", data, 1)[0]
                    image.clear()
                    chunks_received = 0
                    last_chunk_idx = -1
                    reply(CMD_START, STATUS_OK)
                    log(f"  virtual #{SIM_NODE_ID}: START acknowledged ({expected_chunks} chunks expected)")
                elif cmd == CMD_END:
                    log(f"  virtual #{SIM_NODE_ID}: END received ({chunks_received} chunks total)")
                elif cmd == CMD_ABORT:
                    log(f"  virtual #{SIM_NODE_ID}: ABORT received — resetting")
                    image.clear()
                    expected_chunks = None
                    chunks_received = 0
                    last_chunk_idx = -1
                    init_count = 0
                continue

            # ── Unicast control to this node ──
            if arb == CAN_ID_RESPONSE_BASE + 0x80 + SIM_NODE_ID and data:
                # 0x600+N range — VERIFY/APPLY/abort-one
                cmd = data[0]
                if cmd == CMD_VERIFY and len(data) >= 3:
                    expected_crc = struct.unpack_from("<H", data, 1)[0]
                    actual_crc = _crc16_ccitt(bytes(image))
                    ok = (actual_crc == expected_crc)
                    reply(CMD_VERIFY, STATUS_OK if ok else 0x01)
                    log(f"  virtual #{SIM_NODE_ID}: VERIFY → "
                        f"expected 0x{expected_crc:04X}, got 0x{actual_crc:04X} ({'PASS' if ok else 'FAIL'})")
                elif cmd == CMD_APPLY:
                    reply(CMD_APPLY, STATUS_OK)
                    log(f"  virtual #{SIM_NODE_ID}: APPLY acknowledged — pretending to reboot")
                elif cmd == CMD_ABORT:
                    log(f"  virtual #{SIM_NODE_ID}: unicast ABORT received")
    finally:
        try:
            bus.shutdown()
        except Exception:
            pass
        log(f"virtual board #{SIM_NODE_ID} offline")
