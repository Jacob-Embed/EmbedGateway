"""
Per-channel CAN bus coordination so OTA can take exclusive control of a
canalystii channel while telemetry pauses, then telemetry reattaches when
OTA finishes.

The Waveshare USB-CAN-B exposes a single USB device for both logical CAN
channels. Python's canalystii driver opens the whole device (libusb claims
the USB interface), so two `can.Bus(...)` instances cannot coexist on the
same adapter — even targeting different channels. This module gives the
two routers (`serial_bridge`, `ota`) a way to hand the bus over cleanly.

State machine per channel:

    normal      -> _ota_active=False, telemetry holds the bus
    ota-request -> ota sets _ota_active; telemetry sees the flag in its read
                   loop, closes its bus, sets _telemetry_released; ota waits
                   for that event
    ota-running -> ota opens its own can.Bus and runs the protocol
    ota-end     -> ota clears _ota_active; telemetry's loop sees that and
                   reopens the bus

Only one channel needs coordination at a time, but the API is per-channel
so a future dual-port use case still works.
"""

from __future__ import annotations

import asyncio
from typing import Dict


# Per-channel events. Created lazily on first reference (we don't know what
# channels exist until someone asks). asyncio.Event is fine across tasks; the
# uvicorn worker has a single event loop, so all coroutines share it.
_ota_active: Dict[int, asyncio.Event] = {}
_telemetry_released: Dict[int, asyncio.Event] = {}

# Reference count of telemetry sessions currently using a channel. > 0 means
# OTA must request a handover and wait for release. 0 means OTA can open
# the bus directly.
_telemetry_attached: Dict[int, int] = {}


def _events_for(channel: int) -> tuple[asyncio.Event, asyncio.Event]:
    if channel not in _ota_active:
        _ota_active[channel] = asyncio.Event()
        _telemetry_released[channel] = asyncio.Event()
    return _ota_active[channel], _telemetry_released[channel]


# ─────────────────────────────────────────────────────────────────────────────
# Telemetry side
# ─────────────────────────────────────────────────────────────────────────────

def telemetry_attach(channel: int) -> None:
    """Telemetry session is now using this channel."""
    _telemetry_attached[channel] = _telemetry_attached.get(channel, 0) + 1


def telemetry_detach(channel: int) -> None:
    """Telemetry session for this channel ended (clean disconnect)."""
    _telemetry_attached[channel] = max(0, _telemetry_attached.get(channel, 0) - 1)


def is_telemetry_attached(channel: int) -> bool:
    return _telemetry_attached.get(channel, 0) > 0


def is_ota_active(channel: int) -> bool:
    """True when OTA wants/has the bus on this channel. Telemetry should be releasing."""
    active, _ = _events_for(channel)
    return active.is_set()


def signal_telemetry_released(channel: int) -> None:
    """Telemetry has closed its bus on this channel — OTA can now open."""
    _, released = _events_for(channel)
    released.set()


# ─────────────────────────────────────────────────────────────────────────────
# OTA side
# ─────────────────────────────────────────────────────────────────────────────

async def request_ota_takeover(channel: int, timeout: float = 5.0) -> bool:
    """
    Mark the channel as OTA-active and wait for telemetry to release.

    Returns True if telemetry released (or wasn't attached), False if it
    didn't yield within `timeout` seconds — caller should bail out and
    surface the error to the UI.
    """
    active, released = _events_for(channel)
    released.clear()
    active.set()
    if not is_telemetry_attached(channel):
        return True
    try:
        await asyncio.wait_for(released.wait(), timeout)
        return True
    except asyncio.TimeoutError:
        # Telemetry didn't yield. Roll back so it's not stuck pretending to be paused.
        active.clear()
        return False


def release_ota_takeover(channel: int) -> None:
    """OTA finished. Telemetry's read loop will see this and reopen its bus."""
    active, released = _events_for(channel)
    active.clear()
    released.clear()
