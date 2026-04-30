"""In-process dedup + throttle for writing CAN frames to history tables.

Strategy:
- CommLog: only persist when the frame TEXT for a given (board_id, direction, can_id)
  differs from the previous one. Skips repetitive sensor frames.
- SensorReading: at most one row per (board_id, can_id) per second — downsampling
  for graph readability. Values are raw bytes (list of ints 0-255) so the frontend
  parser stays free to change bytes-per-sensor / delimiter without invalidating
  old history.
"""

import asyncio
import time
from typing import Dict, Tuple

from database import save_board_log, save_comm_log, save_sensor_reading

SENSOR_THROTTLE_SEC = 1.0

_last_frame_text: Dict[Tuple[str, str, str], str] = {}
_last_sensor_ts: Dict[Tuple[str, str], float] = {}
# (board_id, log_type, index) -> last value recorded
_last_state: Dict[Tuple[str, str, int], bool] = {}


def _parse_frame(frame_text: str) -> Tuple[str, str]:
    """'200#0B0000...' -> ('200', '0B0000...'). Returns ('', '') if malformed."""
    if "#" not in frame_text:
        return "", ""
    cid, data = frame_text.split("#", 1)
    return cid.strip().upper(), data.strip().upper()


def _hex_bytes(hex_str: str) -> list:
    """'0B0000' -> [11, 0, 0]. Tolerates odd length by truncating."""
    pairs = len(hex_str) // 2
    out = []
    for i in range(pairs):
        try:
            out.append(int(hex_str[i * 2:i * 2 + 2], 16))
        except ValueError:
            break
    return out


async def record_frame(board_id: str, direction: str, frame_text: str):
    """Call once per received/sent CAN frame. Fire-and-forget — errors logged only.

    direction: "rx" | "tx"
    frame_text: e.g. "200#0B000000000000"
    """
    if not frame_text:
        return

    can_id, data_hex = _parse_frame(frame_text)
    if not can_id:
        return

    # 1. CommLog — change-only dedup
    dedup_key = (board_id, direction, can_id)
    last = _last_frame_text.get(dedup_key)
    if last != frame_text:
        _last_frame_text[dedup_key] = frame_text
        try:
            await save_comm_log(board_id, direction, frame_text)
        except Exception as e:
            print(f"[recorder] save_comm_log failed: {e}")

    # 2. SensorReading — 1/sec throttle per (board, canId). RX only.
    if direction == "rx":
        sensor_key = (board_id, can_id)
        now = time.monotonic()
        last_ts = _last_sensor_ts.get(sensor_key, 0.0)
        if now - last_ts >= SENSOR_THROTTLE_SEC and data_hex:
            _last_sensor_ts[sensor_key] = now
            values = _hex_bytes(data_hex)
            if values:
                try:
                    await save_sensor_reading(board_id, can_id, values)
                except Exception as e:
                    print(f"[recorder] save_sensor_reading failed: {e}")


def record_frame_bg(board_id: str, direction: str, frame_text: str):
    """Non-blocking variant — schedules record_frame and returns immediately.
    Use from hot paths where awaiting would block the receive loop."""
    try:
        loop = asyncio.get_event_loop()
        loop.create_task(record_frame(board_id, direction, frame_text))
    except RuntimeError:
        pass


# ── State-change logging (inputs + outputs) ────────────────────────────

async def log_state_change(board_id: str, log_type: str, index: int,
                           value: bool, label: str = ""):
    """Write to BoardLog only when value differs from the last recorded one
    for this (board, type, index). log_type is 'input' | 'output'."""
    key = (board_id, log_type, int(index))
    prev = _last_state.get(key)
    if prev is not None and prev == bool(value):
        return
    _last_state[key] = bool(value)
    try:
        await save_board_log(board_id, log_type, index, value, label)
    except Exception as e:
        print(f"[recorder] save_board_log failed: {e}")


def log_state_change_bg(board_id: str, log_type: str, index: int,
                        value: bool, label: str = ""):
    try:
        loop = asyncio.get_event_loop()
        loop.create_task(log_state_change(board_id, log_type, index, value, label))
    except RuntimeError:
        pass


def log_state_bulk_bg(board_id: str, log_type: str, values: list, label_prefix: str = ""):
    """Convenience: fire one log per changed bit in a list of booleans."""
    for i, v in enumerate(values):
        lbl = f"{label_prefix}{i + 1}" if label_prefix else ""
        log_state_change_bg(board_id, log_type, i, bool(v), lbl)
