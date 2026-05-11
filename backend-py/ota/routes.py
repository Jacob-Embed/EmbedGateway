"""
OTA endpoints — drives the real CAN session through the protocol the
production STM32C092 firmware actually speaks (verified against the
working ota_flash.py reference).

Wire protocol (as implemented by the bootloader on the device side):

    Master -> Bus
        0x600  CTRL  : OTA control (broadcast or unicast — node byte in payload)
        0x6FF  DATA  : firmware chunk stream (idx_hi, idx_lo, 6 data bytes — big-endian)

    Bus -> Master
        0x580 + N     : responses from board N

    Command bytes
        0x10 INIT          0x11 READY        0x12 START
        0x13 CHUNK_ACK     0x14 RETRANSMIT   0x15 END
        0x16 VERIFY        0x17 VERIFY_RESP  0x18 APPLY
        0x1F ABORT

    INIT frame layout (8 bytes):
        [CMD_INIT, node, 0xFF, fw_major, fw_minor, total_hi, total_lo, 0x00]

    VERIFY frame layout (≥6 bytes):
        [CMD_VERIFY, node, total_hi, total_lo, crc_hi, crc_lo]

    DATA chunk layout (8 bytes):
        [idx_hi, idx_lo, b0, b1, b2, b3, b4, b5]   ← chunk index is BIG-ENDIAN

    CRC: CRC-16-CCITT  poly=0x1021  init=0xFFFF   (matches BL_Crc16 in firmware)

This module preserves everything else (BusManager handover for canalystii,
WS fan-out, session lifecycle, abort handling).
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)

try:
    import can  # python-can
    HAS_CAN = True
except ImportError:
    HAS_CAN = False

import bus_manager


router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────────
# Constants — match ota_flash.py / device firmware exactly
# ─────────────────────────────────────────────────────────────────────────────

CTRL_ID    = 0x600
DATA_ID    = 0x6FF
RESP_BASE  = 0x580

CMD_INIT        = 0x10
CMD_READY       = 0x11
CMD_START       = 0x12
CMD_CHUNK_ACK   = 0x13
CMD_RETRANSMIT  = 0x14
CMD_END         = 0x15
CMD_VERIFY      = 0x16
CMD_VERIFY_RESP = 0x17
CMD_APPLY       = 0x18
CMD_ABORT       = 0x1F

# Status byte (offset 2 in READY/VERIFY_RESP). 0x01 = OK on this protocol.
STATUS_READY_OK = 0x01

DATA_BYTES_PER_CHUNK = 6        # 2-byte big-endian index + 6 payload bytes = 8
DEFAULT_FPS          = 3200
ERASE_WAIT_SEC       = 2.5      # post-START delay for flash erase
MAX_RETRANSMIT       = 5

DEFAULT_INTERFACE = "canalystii"
DEFAULT_CHANNEL   = 0
DEFAULT_BITRATE   = 500_000

T_INIT_RESPONSE   = 10.0
T_REBOOT_WAIT     = 2.0
T_END_RESPONSE    = 3.0
T_VERIFY_RESPONSE = 5.0


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def crc16_ccitt(data: bytes) -> int:
    """CRC-16-CCITT — poly 0x1021, init **0xFFFF**. Matches firmware BL_Crc16()."""
    crc = 0xFFFF
    for b in data:
        crc ^= (b << 8) & 0xFFFF
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc


def extract_fw_version(fw: bytes) -> tuple[int, int]:
    """
    Pull (major, minor) from the embedded `Firmware: vX.Y` banner string.

    The board firmware prints this on UART boot; the same string lives in
    .rodata so we can find it in the .bin. Falls back to (1, 0) if absent.
    """
    marker = b"Firmware: v"
    idx = fw.find(marker)
    if idx >= 0:
        rest = fw[idx + len(marker):idx + len(marker) + 16]
        m = re.match(rb"(\d+)\.(\d+)", rest)
        if m:
            return int(m.group(1)), int(m.group(2))
    return 1, 0


# ─────────────────────────────────────────────────────────────────────────────
# Session state
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class BoardState:
    node_id: int
    ready_step1: bool = False
    ready_step2: bool = False
    chunks_received: int = 0
    retransmit_count: int = 0
    crc_match: Optional[bool] = None
    apply_status: str = "PENDING"   # PENDING / APPLIED / SKIPPED / ABORTED

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ready_step1": self.ready_step1,
            "ready_step2": self.ready_step2,
            "chunks_received": self.chunks_received,
            "retransmit_count": self.retransmit_count,
            "crc_match": self.crc_match,
            "apply_status": self.apply_status,
        }


@dataclass
class OtaSession:
    id: str
    firmware: bytes
    target_ids: List[int]
    target_labels: List[str]
    ack_mode: bool
    fps: int
    interface: str
    channel: int
    bitrate: int

    paused: bool = False
    abort_requested: bool = False

    ws_clients: Set[WebSocket] = field(default_factory=set)
    queue: "asyncio.Queue[Optional[Dict[str, Any]]]" = field(default_factory=asyncio.Queue)
    boards: Dict[int, BoardState] = field(default_factory=dict)

    started_at: float = field(default_factory=time.monotonic)


SESSIONS: Dict[str, OtaSession] = {}


# ─────────────────────────────────────────────────────────────────────────────
# Event fan-out
# ─────────────────────────────────────────────────────────────────────────────

async def _emit(session: OtaSession, event: Dict[str, Any]) -> None:
    await session.queue.put(event)


async def _fanout_loop(session: OtaSession) -> None:
    while True:
        ev = await session.queue.get()
        if ev is None:
            return
        dead: List[WebSocket] = []
        for ws in list(session.ws_clients):
            try:
                await ws.send_json(ev)
            except Exception:
                dead.append(ws)
        for ws in dead:
            session.ws_clients.discard(ws)


# ─────────────────────────────────────────────────────────────────────────────
# Bus I/O — run blocking python-can calls in the executor
# ─────────────────────────────────────────────────────────────────────────────

async def _bus_send(bus: "can.Bus", arb_id: int, data: bytes) -> None:
    msg = can.Message(arbitration_id=arb_id, data=data, is_extended_id=False)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: bus.send(msg, timeout=0.5))


async def _bus_recv(bus: "can.Bus", timeout: float) -> Optional["can.Message"]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: bus.recv(timeout=timeout))


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/ota/start")
async def ota_start(
    firmware: UploadFile = File(...),
    config: str = Form(...),
):
    if not HAS_CAN:
        raise HTTPException(503, "python-can not installed on backend")

    try:
        cfg = json.loads(config)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"invalid config JSON: {exc}")

    target_labels = list(cfg.get("target_node_ids") or [])
    if not target_labels:
        raise HTTPException(400, "no targets selected")

    fw_bytes = await firmware.read()
    if not fw_bytes:
        raise HTTPException(400, "firmware blob is empty")

    target_ids = list(range(1, len(target_labels) + 1))

    session = OtaSession(
        id=uuid.uuid4().hex[:8],
        firmware=fw_bytes,
        target_ids=target_ids,
        target_labels=target_labels,
        ack_mode=bool(cfg.get("ack_mode", True)),
        fps=max(100, min(int(cfg.get("fps", DEFAULT_FPS)), DEFAULT_FPS)),
        interface=str(cfg.get("interface", DEFAULT_INTERFACE)),
        channel=int(cfg.get("channel", DEFAULT_CHANNEL)),
        bitrate=int(cfg.get("bitrate", DEFAULT_BITRATE)),
    )
    for nid in target_ids:
        session.boards[nid] = BoardState(node_id=nid)

    SESSIONS[session.id] = session
    asyncio.create_task(_fanout_loop(session))
    asyncio.create_task(_run_session(session))
    print(f"[ota] session {session.id} started ({len(target_ids)} targets, {len(fw_bytes)} B firmware)")
    return {"session_id": session.id}


@router.post("/ota/pause")
async def ota_pause():
    for s in SESSIONS.values():
        if s.ack_mode:
            s.paused = True
    return {"ok": True, "sessions": list(SESSIONS.keys())}


@router.post("/ota/resume")
async def ota_resume():
    for s in SESSIONS.values():
        s.paused = False
    return {"ok": True, "sessions": list(SESSIONS.keys())}


@router.post("/ota/abort")
async def ota_abort():
    for s in SESSIONS.values():
        s.abort_requested = True
    return {"ok": True, "sessions": list(SESSIONS.keys())}


@router.websocket("/ws/ota")
async def ws_ota(websocket: WebSocket, session: str = ""):
    await websocket.accept()
    s = SESSIONS.get(session)
    if not s:
        await websocket.send_json({
            "type": "log", "level": "ERROR",
            "message": f"unknown OTA session: {session}",
        })
        await websocket.close()
        return

    s.ws_clients.add(websocket)
    for board in s.boards.values():
        with suppress(Exception):
            await websocket.send_json({
                "type": "board_status",
                "node_id": str(board.node_id),
                "status": board.to_dict(),
            })

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        s.ws_clients.discard(websocket)


# ─────────────────────────────────────────────────────────────────────────────
# State machine — single-target flow that mirrors ota_flash.py exactly
# ─────────────────────────────────────────────────────────────────────────────

class _Aborted(Exception):
    pass


async def _run_session(s: OtaSession) -> None:
    bus: Optional["can.Bus"] = None

    async def log(level: str, message: str) -> None:
        await _emit(s, {"type": "log", "level": level, "message": message})

    async def phase(p: str) -> None:
        await _emit(s, {"type": "phase", "phase": p})

    async def progress(done: int, total: int) -> None:
        await _emit(s, {"type": "progress", "chunks_done": done, "chunks_total": total})

    async def push_board(nid: int) -> None:
        b = s.boards.get(nid)
        if b is not None:
            await _emit(s, {"type": "board_status", "node_id": str(nid), "status": b.to_dict()})

    def check_abort() -> None:
        if s.abort_requested:
            raise _Aborted()

    if not s.target_ids:
        await log("ERROR", "no target nodes")
        await phase("ABORTED")
        await _emit(s, {"type": "finished", "summary": _summary(s, abort_reason="no targets")})
        await s.queue.put(None)
        return

    # The wire protocol addresses one node at a time (node byte in every
    # control frame). Process the first selected target; the rest are marked
    # SKIPPED so the UI is honest about it.
    node = s.target_ids[0]
    if len(s.target_ids) > 1:
        await log(
            "WARN",
            f"protocol is single-target — flashing #{node} only; the other "
            f"{len(s.target_ids) - 1} target(s) will be marked SKIPPED",
        )
        for extra in s.target_ids[1:]:
            s.boards[extra].apply_status = "SKIPPED"
            await push_board(extra)

    # Pad firmware to a multiple of CHUNK_SIZE with the erased-flash value.
    fw = bytearray(s.firmware)
    rem = len(fw) % DATA_BYTES_PER_CHUNK
    if rem:
        fw += b"\xFF" * (DATA_BYTES_PER_CHUNK - rem)
    total_chunks = len(fw) // DATA_BYTES_PER_CHUNK
    crc = crc16_ccitt(bytes(fw))
    fw_major, fw_minor = extract_fw_version(bytes(fw))

    await log(
        "INFO",
        f"firmware: {len(fw)} B padded, {total_chunks} chunks, "
        f"CRC16 0x{crc:04X}, v{fw_major}.{fw_minor}",
    )

    try:
        # ── Take the bus over from telemetry ────────────────────────────────
        if bus_manager.is_telemetry_attached(s.channel):
            await log("INFO", f"asking telemetry to release CAN{s.channel + 1}…")
        ok = await bus_manager.request_ota_takeover(s.channel, timeout=5.0)
        if not ok:
            await log("ERROR", f"telemetry didn't release CAN{s.channel + 1} within 5s")
            await phase("ABORTED")
            await _emit(s, {"type": "finished",
                            "summary": _summary(s, abort_reason="telemetry handover timeout")})
            return

        await log("INFO", f"opening CAN bus: {s.interface} ch{s.channel} @ {s.bitrate} bps")
        try:
            bus = can.Bus(interface=s.interface, channel=s.channel, bitrate=s.bitrate)
        except Exception as exc:
            await log("ERROR", f"bus open failed: {exc}")
            await phase("ABORTED")
            await _emit(s, {"type": "finished", "summary": _summary(s, abort_reason=str(exc))})
            return

        await progress(0, total_chunks)

        # ── 1. INIT ─────────────────────────────────────────────────────────
        await phase("INIT_STEP1")
        await log("INFO", f"OTA_CMD_INIT to node #{node} (fw v{fw_major}.{fw_minor})")
        await _bus_send(
            bus,
            CTRL_ID,
            bytes([CMD_INIT, node, 0xFF, fw_major, fw_minor,
                   (total_chunks >> 8) & 0xFF, total_chunks & 0xFF, 0x00]),
        )
        r = await _wait_resp(s, bus, node, CMD_READY, T_INIT_RESPONSE, track_diag=True)
        if r is None:
            reason = _format_init_diag(s, node)
            await log("ERROR", f"step1: {reason}")
            for nid in s.target_ids:
                if s.boards[nid].apply_status == "PENDING":
                    s.boards[nid].apply_status = "SKIPPED"
                    await push_board(nid)
            await phase("ABORTED")
            await _emit(s, {"type": "finished", "summary": _summary(s, abort_reason=reason)})
            return

        if len(r) < 7 or r[2] != STATUS_READY_OK:
            codes = {0x01: "BUSY", 0x02: "HW_MISMATCH"}
            reason = codes.get(r[3] if len(r) > 3 else 0, f"code 0x{r[3]:02X}" if len(r) > 3 else "malformed")
            await log("ERROR", f"INIT rejected: {reason}")
            await phase("ABORTED")
            await _emit(s, {"type": "finished", "summary": _summary(s, abort_reason=f"INIT rejected: {reason}")})
            return

        hw_byte    = r[4]
        bl_major   = r[5]
        bl_minor   = r[6]
        await log("INFO", f"  #{node}: READY (hw=0x{hw_byte:02X} ver={bl_major}.{bl_minor})")
        s.boards[node].ready_step1 = True
        await push_board(node)

        # The bootloader self-identifies as v0.1; anything else means the
        # application responded — it'll set the OTA boot-request flag and reset.
        app_responded = not (bl_major == 0 and bl_minor == 1)

        if app_responded:
            await phase("REBOOT_WAIT")
            await log("INFO", "application rebooting to bootloader (waiting 2s)")
            await _sleep_cancellable(s, T_REBOOT_WAIT)

            await phase("INIT_STEP2")
            await log("INFO", "OTA_CMD_INIT to bootloader")
            await _bus_send(
                bus,
                CTRL_ID,
                bytes([CMD_INIT, node, 0xFF, fw_major, fw_minor,
                       (total_chunks >> 8) & 0xFF, total_chunks & 0xFF, 0x00]),
            )
            r = await _wait_resp(s, bus, node, CMD_READY, T_INIT_RESPONSE)
            if r is None:
                await log("ERROR", "bootloader did not respond after reboot")
                await phase("ABORTED")
                await _emit(s, {"type": "finished",
                                "summary": _summary(s, abort_reason="bootloader silent")})
                return
            if len(r) < 7 or r[2] != STATUS_READY_OK:
                code = r[3] if len(r) > 3 else 0
                await log("ERROR", f"bootloader REJECTED: code 0x{code:02X}")
                await phase("ABORTED")
                await _emit(s, {"type": "finished",
                                "summary": _summary(s, abort_reason=f"bootloader rejected 0x{code:02X}")})
                return
            await log("INFO", f"  #{node}: bootloader READY (v{r[5]}.{r[6]})")

        s.boards[node].ready_step2 = True
        await push_board(node)

        # ── 2. START ────────────────────────────────────────────────────────
        await phase("STARTING")
        await log("INFO", f"OTA_CMD_START — flash erase ~{ERASE_WAIT_SEC}s")
        await _bus_send(bus, CTRL_ID, bytes([CMD_START, node]))
        await _sleep_cancellable(s, ERASE_WAIT_SEC)
        await _drain(bus, 0.02)

        # ── 3. STREAM ───────────────────────────────────────────────────────
        # Hot path: direct synchronous bus.send/recv (no executor hops), with
        # time.sleep for accurate sub-millisecond pacing — asyncio.sleep on
        # Windows has ~15 ms timer granularity, so it would cap streaming at
        # ~66 fps regardless of the configured rate. We yield to the event
        # loop every 32 chunks so WebSocket progress events still flow.
        await phase("STREAMING")
        await log("INFO", f"streaming {total_chunks} chunks @ target {s.fps} fps (firmware {len(fw)} B)")
        delay = 1.0 / max(s.fps, 1)
        idx = 0
        last_progress_idx = -1
        last_logged_idx = 0
        stream_start = time.monotonic()
        PROGRESS_EMIT_EVERY = 256
        YIELD_EVERY = 32

        while idx < total_chunks:
            check_abort()
            while s.paused and not s.abort_requested:
                await asyncio.sleep(0.05)
            check_abort()

            payload = bytes(fw[idx * DATA_BYTES_PER_CHUNK:(idx + 1) * DATA_BYTES_PER_CHUNK])
            chunk_data = bytes([(idx >> 8) & 0xFF, idx & 0xFF]) + payload
            try:
                bus.send(can.Message(arbitration_id=DATA_ID, data=chunk_data, is_extended_id=False),
                         timeout=0.5)
            except can.CanError as exc:
                await log("ERROR", f"CAN TX failed at chunk {idx}: {exc}")
                await phase("ABORTED")
                await _emit(s, {"type": "finished",
                                "summary": _summary(s, abort_reason=f"TX failed: {exc}")})
                return

            # Synchronous non-blocking poll for ACK / RETRANSMIT.
            m = bus.recv(timeout=0.0)
            if m is not None and m.arbitration_id == RESP_BASE + node and m.dlc >= 1:
                rdata = bytes(m.data[:m.dlc])
                cmd = rdata[0]
                if cmd == CMD_RETRANSMIT and len(rdata) >= 4:
                    rewind = (rdata[2] << 8) | rdata[3]
                    err = rdata[4] if len(rdata) > 4 else 0
                    s.boards[node].retransmit_count += 1
                    await push_board(node)
                    await log("WARN", f"  RETRANSMIT — rewinding to chunk {rewind} (err={err})")
                    if s.boards[node].retransmit_count > MAX_RETRANSMIT:
                        await log("ERROR", f"  exceeded {MAX_RETRANSMIT} retransmits — aborting board")
                        try:
                            bus.send(can.Message(arbitration_id=CTRL_ID,
                                                  data=bytes([CMD_ABORT, node]),
                                                  is_extended_id=False), timeout=0.5)
                        except Exception:
                            pass
                        s.boards[node].apply_status = "ABORTED"
                        await push_board(node)
                        await phase("ABORTED")
                        await _emit(s, {"type": "finished",
                                        "summary": _summary(s, abort_reason="retransmit budget exceeded")})
                        return
                    idx = rewind
                    last_logged_idx = idx
                    continue
                elif cmd == CMD_CHUNK_ACK and len(rdata) >= 4:
                    acked = (rdata[2] << 8) | rdata[3]
                    s.boards[node].chunks_received = acked + 1
                    if acked - last_progress_idx >= 32 or acked + 1 == total_chunks:
                        last_progress_idx = acked
                        # Note: we don't await progress here to keep the hot loop tight.
                        # Periodic awaits below flush queued events.

            idx += 1

            # Periodic visibility: every 256 chunks, emit progress + a "TX block"
            # log line so you can see which chunks just went out and the actual
            # achieved frame rate.
            if idx - last_logged_idx >= PROGRESS_EMIT_EVERY or idx == total_chunks:
                elapsed = time.monotonic() - stream_start
                cum_rate = idx / max(0.001, elapsed)
                window_rate = (idx - last_logged_idx) / max(0.001, elapsed - (last_logged_idx / max(cum_rate, 1)))
                # Window rate gets noisy near the start; fall back to cumulative for first batches.
                shown_rate = cum_rate if last_logged_idx < PROGRESS_EMIT_EVERY else window_rate
                last_logged_idx = idx
                await progress(idx, total_chunks)
                await push_board(node)
                await log(
                    "INFO",
                    f"  TX {idx}/{total_chunks} chunks  "
                    f"({int(cum_rate)} fps avg, last block ~{int(shown_rate)} fps, "
                    f"{idx * DATA_BYTES_PER_CHUNK} B sent)",
                )

            # Yield to the event loop so queued WS emits actually flow.
            elif idx % YIELD_EVERY == 0:
                await asyncio.sleep(0)

            # High-resolution pacing. time.sleep beats asyncio.sleep on Windows
            # for sub-ms accuracy; only ~3-4 µs busy-loop floor on most systems.
            if delay > 0:
                time.sleep(delay)

        # Final progress emit
        s.boards[node].chunks_received = total_chunks
        await progress(total_chunks, total_chunks)
        await push_board(node)
        elapsed_total = time.monotonic() - stream_start
        await log("INFO",
                  f"streaming done — {total_chunks} chunks in {elapsed_total:.1f}s "
                  f"({int(total_chunks / max(elapsed_total, 0.001))} fps avg)")

        # ── 4. END ──────────────────────────────────────────────────────────
        await phase("ENDING")
        await log("INFO", "OTA_CMD_END")
        await _bus_send(bus, CTRL_ID, bytes([CMD_END, node]))
        r = await _wait_resp(s, bus, node, CMD_CHUNK_ACK, T_END_RESPONSE)
        if r is not None and len(r) >= 4:
            last = (r[2] << 8) | r[3]
            err = r[4] if len(r) > 4 else 0
            await log("INFO", f"  END ACK: last_chunk={last} err={err}")
        else:
            await log("INFO", "  END (no final ACK — continuing)")

        # ── 5. VERIFY ───────────────────────────────────────────────────────
        await phase("VERIFYING")
        await log("INFO", f"OTA_CMD_VERIFY — expected CRC=0x{crc:04X}")
        await _bus_send(
            bus,
            CTRL_ID,
            bytes([CMD_VERIFY, node,
                   (total_chunks >> 8) & 0xFF, total_chunks & 0xFF,
                   (crc >> 8) & 0xFF, crc & 0xFF]),
        )
        r = await _wait_resp(s, bus, node, CMD_VERIFY_RESP, T_VERIFY_RESPONSE)
        if r is None:
            await log("ERROR", "no VERIFY_RESP from board")
            s.boards[node].crc_match = False
            s.boards[node].apply_status = "SKIPPED"
            await push_board(node)
            await phase("ABORTED")
            await _emit(s, {"type": "finished",
                            "summary": _summary(s, abort_reason="no VERIFY_RESP")})
            return

        verify_status = r[2] if len(r) > 2 else 0
        if verify_status != STATUS_READY_OK:
            board_crc = ((r[4] << 8) | r[5]) if len(r) >= 6 else 0
            await log("ERROR", f"CRC FAIL — board=0x{board_crc:04X} expected=0x{crc:04X}")
            s.boards[node].crc_match = False
            s.boards[node].apply_status = "SKIPPED"
            await push_board(node)
            await phase("ABORTED")
            await _emit(s, {"type": "finished", "summary": _summary(s, abort_reason="CRC mismatch")})
            return

        await log("INFO", "  CRC PASS ✓")
        s.boards[node].crc_match = True
        await push_board(node)

        # ── 6. APPLY ────────────────────────────────────────────────────────
        await phase("APPLYING")
        await log("INFO", "OTA_CMD_APPLY — board will reset and jump to application")
        await _bus_send(bus, CTRL_ID, bytes([CMD_APPLY, node]))
        await _sleep_cancellable(s, 0.3)
        s.boards[node].apply_status = "APPLIED"
        await push_board(node)

        await phase("COMPLETE")
        await _emit(s, {"type": "finished", "summary": _summary(s, success=True)})

    except _Aborted:
        if bus is not None:
            with suppress(Exception):
                await _bus_send(bus, CTRL_ID, bytes([CMD_ABORT, s.target_ids[0] if s.target_ids else 0]))
        await log("WARN", "aborted by user")
        await phase("ABORTED")
        await _emit(s, {"type": "finished", "summary": _summary(s, abort_reason="user abort")})
    except Exception as exc:
        await log("ERROR", f"unhandled error: {exc}")
        await phase("ABORTED")
        await _emit(s, {"type": "finished", "summary": _summary(s, abort_reason=str(exc))})
    finally:
        await s.queue.put(None)
        if bus is not None:
            with suppress(Exception):
                bus.shutdown()
        bus_manager.release_ota_takeover(s.channel)
        SESSIONS.pop(s.id, None)
        print(f"[ota] session {s.id} ended")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers — wait for a specific response, drain bus, sleep cancellably, etc.
# ─────────────────────────────────────────────────────────────────────────────

async def _wait_resp(
    s: OtaSession,
    bus: "can.Bus",
    node: int,
    cmd: int,
    timeout: float,
    track_diag: bool = False,
) -> Optional[bytes]:
    """
    Block until a response frame from `node` with the given `cmd` byte arrives,
    or `timeout` elapses. Returns the response bytes (truncated to dlc).

    When `track_diag=True`, also notes any non-OTA traffic on the bus so we
    can produce a precise post-mortem on a no-response timeout.
    """
    deadline = time.monotonic() + timeout
    seen_alive_boards: Set[int] = set()
    other_frames = 0

    while time.monotonic() < deadline:
        if s.abort_requested:
            raise _Aborted()
        msg = await _bus_recv(bus, 0.05)
        if msg is None:
            continue

        arb = msg.arbitration_id
        if track_diag:
            if 0x181 <= arb <= 0x1E4:
                seen_alive_boards.add(arb - 0x180)
            elif 0x281 <= arb <= 0x2E4:
                seen_alive_boards.add(arb - 0x280)
            elif arb < RESP_BASE or arb > 0x5FF:
                other_frames += 1

        if arb != RESP_BASE + node:
            continue
        dlc = msg.dlc if hasattr(msg, "dlc") and msg.dlc else len(msg.data)
        if dlc < 1:
            continue
        data = bytes(msg.data[:dlc])
        if data[0] == cmd:
            return data

    if track_diag:
        s._last_init_diagnostic = {                   # type: ignore[attr-defined]
            "alive_boards": sorted(seen_alive_boards),
            "other_frames": other_frames,
        }
    return None


def _format_init_diag(s: OtaSession, node: int) -> str:
    """Translate the diagnostic gathered during INIT into a precise reason."""
    diag = getattr(s, "_last_init_diagnostic", None) or {}
    alive = diag.get("alive_boards") or []
    other = int(diag.get("other_frames") or 0)
    if alive:
        ids_str = ", ".join(f"#{n}" for n in alive[:8]) + ("…" if len(alive) > 8 else "")
        return (
            f"no READY from #{node} but boards alive on bus ({ids_str}). "
            f"Likely target NodeID mismatch — firmware looks fine."
        )
    if other > 0:
        return f"saw {other} non-OTA frame(s) but no READY response from #{node}"
    return (
        f"bus is silent on CAN{s.channel + 1} — no traffic at all during the "
        f"{T_INIT_RESPONSE}s INIT window. Check wiring, channel, bitrate, and "
        f"that #{node} is powered."
    )


async def _drain(bus: "can.Bus", duration_sec: float) -> None:
    """Consume and discard any pending frames for a short window."""
    deadline = time.monotonic() + duration_sec
    while time.monotonic() < deadline:
        msg = await _bus_recv(bus, 0.005)
        if msg is None:
            break


async def _sleep_cancellable(s: OtaSession, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if s.abort_requested:
            raise _Aborted()
        await asyncio.sleep(0.05)


def _summary(s: OtaSession, success: bool = False, abort_reason: str = "") -> Dict[str, Any]:
    rows = list(s.boards.values())
    return {
        "total_targets": len(rows),
        "applied": sum(1 for b in rows if b.apply_status == "APPLIED"),
        "skipped": sum(1 for b in rows if b.apply_status == "SKIPPED"),
        "aborted": sum(1 for b in rows if b.apply_status == "ABORTED"),
        "failed":  sum(1 for b in rows if b.crc_match is False and b.apply_status != "APPLIED"),
        "duration_sec": round(time.monotonic() - s.started_at, 2),
        "success": success,
        "abort_reason": abort_reason,
    }
