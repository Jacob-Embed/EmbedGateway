"""USB-CAN Bridge — supports Waveshare USB-CAN-B (CANalyst-II) and serial COM port adapters.

Two modes:
1. python-can + canalystii — for Waveshare USB-CAN-B (VID 04D8:0053) — no COM port needed
2. pyserial fallback — for adapters that create a COM/serial port (slcan, etc.)
"""

import time
import asyncio
import os
import sys
from typing import List
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from protocol import CrefFrame, decode_board_state
from boards.service import board_registry, register_board, update_board
from history_recorder import log_state_bulk_bg, record_frame_bg
import bus_manager

router = APIRouter(tags=["serial"])

# ── Setup libusb DLL path (must happen before any USB imports) ──
_LIBUSB_DLL_DIRS = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ""),
    os.path.join(sys.prefix, "Lib", "site-packages", "libusb", "_platform", "windows", "x86_64"),
    r"E:\Python\Lib\site-packages\libusb\_platform\windows\x86_64",
]
for _d in _LIBUSB_DLL_DIRS:
    if os.path.isdir(_d) and os.path.exists(os.path.join(_d, "libusb-1.0.dll")):
        try:
            os.add_dll_directory(_d)
        except Exception:
            pass
        break

# ── Try importing pyusb for device detection ──
_usb_backend = None
HAS_USB = False
try:
    import usb.core
    import usb.backend.libusb1

    _dll_candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "libusb-1.0.dll"),
        os.path.join(sys.prefix, "Lib", "site-packages", "libusb", "_platform", "windows", "x86_64", "libusb-1.0.dll"),
        r"E:\Python\Lib\site-packages\libusb\_platform\windows\x86_64\libusb-1.0.dll",
    ]
    for _dll in _dll_candidates:
        if os.path.exists(_dll):
            try:
                _usb_backend = usb.backend.libusb1.get_backend(find_library=lambda x, p=_dll: p)
                if _usb_backend:
                    break
            except Exception:
                pass
    if not _usb_backend:
        _usb_backend = usb.backend.libusb1.get_backend()
    HAS_USB = _usb_backend is not None

    # Monkey-patch usb.core.find so canalystii uses our backend automatically
    if _usb_backend:
        _orig_usb_find = usb.core.find
        def _patched_usb_find(*args, **kwargs):
            if "backend" not in kwargs:
                kwargs["backend"] = _usb_backend
            return _orig_usb_find(*args, **kwargs)
        usb.core.find = _patched_usb_find
        print(f"[serial] libusb backend ready (patched)")
except Exception as e:
    print(f"[serial] pyusb/libusb not available: {e}")

# ── Try importing python-can (preferred for USB-CAN-B) ──
try:
    import can
    HAS_PYTHON_CAN = True
except ImportError:
    HAS_PYTHON_CAN = False
    print("[serial] python-can not installed — install with: pip install python-can[canalystii]")

# ── Try importing pyserial (fallback for COM port adapters) ──
try:
    import serial
    import serial.tools.list_ports
    HAS_SERIAL = True
except ImportError:
    HAS_SERIAL = False
    print("[serial] pyserial not installed — install with: pip install pyserial")


# Waveshare USB-CAN-B identifiers
WAVESHARE_VID = 0x04D8
WAVESHARE_PID = 0x0053


def list_com_ports() -> List[dict]:
    """List all available COM/serial ports with device info."""
    if not HAS_SERIAL:
        return []
    ports = []
    for p in serial.tools.list_ports.comports():
        ports.append({
            "port": p.device,
            "description": p.description,
            "hwid": p.hwid,
            "vid": p.vid,
            "pid": p.pid,
            "manufacturer": p.manufacturer or "",
            "serial_number": p.serial_number or "",
            "is_usb": p.vid is not None,
        })
    return ports


def detect_usb_can_devices() -> List[dict]:
    """Detect USB-CAN adapters — checks both USB bus and COM ports."""
    devices = []

    # Check via pyusb (for Waveshare USB-CAN-B)
    if HAS_USB and _usb_backend:
        try:
            dev = usb.core.find(idVendor=WAVESHARE_VID, idProduct=WAVESHARE_PID, backend=_usb_backend)
            if dev:
                devices.append({
                    "type": "usb-can",
                    "port": f"USB:{hex(WAVESHARE_VID)}:{hex(WAVESHARE_PID)}",
                    "description": "Waveshare USB-CAN-B (CANalyst-II)",
                    "manufacturer": "Waveshare/Chuangxin",
                    "interface": "canalystii",
                    "vid": WAVESHARE_VID,
                    "pid": WAVESHARE_PID,
                    "driver_ok": True,
                    "channel": 0,
                })
                # Channel 2
                devices.append({
                    "type": "usb-can",
                    "port": f"USB:{hex(WAVESHARE_VID)}:{hex(WAVESHARE_PID)}:CH2",
                    "description": "Waveshare USB-CAN-B CAN2 (CANalyst-II)",
                    "manufacturer": "Waveshare/Chuangxin",
                    "interface": "canalystii",
                    "vid": WAVESHARE_VID,
                    "pid": WAVESHARE_PID,
                    "driver_ok": True,
                    "channel": 1,
                })
        except Exception as e:
            # Device exists but driver not installed
            devices.append({
                "type": "usb-can",
                "port": f"USB:{hex(WAVESHARE_VID)}:{hex(WAVESHARE_PID)}",
                "description": "Waveshare USB-CAN-B — DRIVER NOT INSTALLED",
                "manufacturer": "Waveshare/Chuangxin",
                "interface": "canalystii",
                "vid": WAVESHARE_VID,
                "pid": WAVESHARE_PID,
                "driver_ok": False,
                "error": str(e),
            })

    # Also check via Windows PnP (fallback detection even without libusb driver)
    if not devices:
        try:
            import subprocess
            result = subprocess.run(
                ["powershell", "-Command",
                 "Get-WmiObject Win32_PnPEntity | Where-Object { $_.DeviceID -match 'VID_04D8' } | Select-Object Name, DeviceID, Status | ConvertTo-Json"],
                capture_output=True, text=True, timeout=5
            )
            if result.stdout.strip():
                import json
                data = json.loads(result.stdout)
                if isinstance(data, dict):
                    data = [data]
                for d in data:
                    devices.append({
                        "type": "usb-can",
                        "port": "USB:waveshare",
                        "description": d.get("Name", "USB-CAN-B"),
                        "manufacturer": "Waveshare/Chuangxin",
                        "interface": "canalystii",
                        "driver_ok": d.get("Status") == "OK",
                        "windows_status": d.get("Status", "Unknown"),
                        "device_id": d.get("DeviceID", ""),
                    })
        except Exception:
            pass

    # Check COM ports for serial-based CAN adapters
    for p in list_com_ports():
        desc_lower = (p["description"] or "").lower()
        can_keywords = ["can", "slcan", "canable", "usb-can", "gs_usb", "candlelight", "innomaker"]
        is_can = any(kw in desc_lower for kw in can_keywords)
        if is_can or p["is_usb"]:
            devices.append({
                "type": "serial",
                "port": p["port"],
                "description": p["description"],
                "manufacturer": p["manufacturer"],
                "interface": "serial",
                "driver_ok": True,
                "likely_can": is_can,
            })

    return devices


@router.get("/serial/ports")
async def get_serial_ports():
    """List all available serial/COM ports."""
    com_ports = list_com_ports() if HAS_SERIAL else []
    return {"ports": com_ports, "available": HAS_SERIAL}


@router.get("/serial/detect")
async def detect_devices():
    """Detect all USB-CAN adapters (USB + serial)."""
    devices = detect_usb_can_devices()
    return {
        "devices": devices,
        "has_python_can": HAS_PYTHON_CAN,
        "has_serial": HAS_SERIAL,
        "has_usb": HAS_USB,
    }


@router.websocket("/ws/serial")
async def websocket_serial_bridge(websocket: WebSocket):
    """WebSocket bridge for USB-CAN communication.

    Config options:
    1. { interface: "canalystii", channel: 0, bitrate: 500000 }  — Waveshare USB-CAN-B
    2. { com_port: "COM3", baud_rate: 115200 }                   — Serial/slcan adapter
    """
    await websocket.accept()
    bridge_open = True

    try:
        config = await websocket.receive_json()
        interface = config.get("interface", "serial")

        if interface == "canalystii":
            # ── Waveshare USB-CAN-B via python-can ──
            if not HAS_PYTHON_CAN:
                await websocket.send_json({"error": "python-can not installed. Run: pip install python-can[canalystii]"})
                await websocket.close()
                return

            channel = int(config.get("channel", 0))
            bitrate = int(config.get("bitrate", 500000))
            await websocket.send_json({"status": f"Opening USB-CAN-B CAN{channel+1} at {bitrate} bps..."})

            try:
                bus = can.Bus(interface="canalystii", channel=channel, bitrate=bitrate)
            except Exception as e:
                error_msg = str(e)
                if "No backend" in error_msg or "not found" in error_msg.lower():
                    error_msg += "\n\nFix: Install WinUSB driver using Zadig (zadig-2.9.exe on Desktop).\n1. Options > List All Devices\n2. Select 'Chuangxin Tech USBCAN'\n3. Set driver to WinUSB\n4. Click Install Driver"
                await websocket.send_json({"error": f"Failed to open USB-CAN-B: {error_msg}"})
                await websocket.close()
                return

            await websocket.send_json({"status": "SERIAL_CONNECTED", "message": f"USB-CAN-B CAN{channel+1} @ {bitrate} bps"})

            board_id = f"USB:CAN{channel+1}"
            await register_board(board_id, f"USB-CAN-B:CAN{channel+1}", bitrate)
            print(f"[serial] Board {board_id} registered (canalystii ch{channel} @ {bitrate})")
            bus_manager.telemetry_attach(channel)

            async def _yield_to_ota_if_requested():
                """If OTA wants the bus, close it, wait for OTA to finish, reopen."""
                nonlocal bus
                if not bus_manager.is_ota_active(channel):
                    return
                print(f"[serial] OTA takeover requested on CAN{channel+1} — releasing bus")
                try:
                    bus.shutdown()
                except Exception:
                    pass
                bus_manager.signal_telemetry_released(channel)
                # Wait for OTA to clear the flag (poll cheaply; ota_active is an asyncio.Event).
                while bus_manager.is_ota_active(channel) and bridge_open:
                    await asyncio.sleep(0.2)
                if not bridge_open:
                    return
                # Reopen on the same params.
                try:
                    bus = can.Bus(interface="canalystii", channel=channel, bitrate=bitrate)
                    print(f"[serial] CAN{channel+1} reopened after OTA")
                    try:
                        await websocket.send_json({"status": "SERIAL_RECONNECTED",
                                                   "message": f"USB-CAN-B CAN{channel+1} reattached after OTA"})
                    except Exception:
                        pass
                except Exception as exc:
                    print(f"[serial] failed to reopen CAN{channel+1} after OTA: {exc}")
                    try:
                        await websocket.send_json({"error": f"failed to reopen after OTA: {exc}"})
                    except Exception:
                        pass

            async def can_to_ws():
                """Read CAN frames and forward to WebSocket."""
                nonlocal bridge_open, bus
                loop = asyncio.get_event_loop()
                try:
                    while bridge_open:
                        await _yield_to_ota_if_requested()
                        if not bridge_open:
                            break
                        msg = await loop.run_in_executor(None, lambda: bus.recv(timeout=0.1))
                        if msg is None:
                            continue

                        board = board_registry.get(board_id)
                        if board:
                            board.last_heartbeat = time.time()

                        # Format as CAN frame text: "200#0F"
                        can_id = f"{msg.arbitration_id:03X}"
                        can_data = msg.data.hex().upper()
                        frame_text = f"{can_id}#{can_data}"
                        record_frame_bg(board_id, "rx", frame_text)

                        # Parse input frames (CAN ID 0x200)
                        if msg.arbitration_id == 0x200 and len(msg.data) >= 1:
                            b = board_registry.get(board_id)
                            if b:
                                new_inputs = [bool(msg.data[0] & (1 << i)) for i in range(4)]
                                b.inputs = new_inputs
                                b.last_heartbeat = time.time()
                                log_state_bulk_bg(board_id, "input", new_inputs, "DI")
                                await update_board(b)

                        # Parse status frames
                        if msg.arbitration_id == 0x100 and len(msg.data) >= 2:
                            b = board_registry.get(board_id)
                            if b:
                                from protocol import decode_outputs
                                new_outputs = decode_outputs(msg.data[:2])
                                b.outputs = new_outputs
                                b.last_heartbeat = time.time()
                                log_state_bulk_bg(board_id, "output", new_outputs, "DO")
                                await update_board(b)

                        # Forward to WebSocket as CAN frame text (same format as TCP bridge)
                        frame_bytes = (frame_text + "\n").encode("utf-8")
                        try:
                            await websocket.send_json({
                                "message": frame_bytes.hex(),
                                "format": "hex",
                                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                            })
                        except Exception:
                            bridge_open = False
                            break
                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    if "after sending" not in str(e):
                        print(f"[serial] can_to_ws error: {e}")
                finally:
                    bridge_open = False

            async def ws_to_can():
                """Read from WebSocket and send CAN frames."""
                nonlocal bridge_open, bus
                loop = asyncio.get_event_loop()
                try:
                    while bridge_open:
                        # Hold off TX while OTA owns the bus — bus may be shut.
                        while bus_manager.is_ota_active(channel) and bridge_open:
                            await asyncio.sleep(0.1)
                        if not bridge_open:
                            break
                        ws_msg = await websocket.receive()
                        payload = None
                        if "text" in ws_msg and ws_msg["text"] is not None:
                            payload = ws_msg["text"]
                        elif "bytes" in ws_msg and ws_msg["bytes"] is not None:
                            payload = ws_msg["bytes"].decode("utf-8", errors="replace")
                        else:
                            break

                        if not payload:
                            continue

                        # Parse CAN frame text: "100#AABB"
                        for line in payload.strip().split("\n"):
                            line = line.strip("\r\n\t ")
                            if not line or "#" not in line:
                                continue
                            try:
                                can_id_str, can_data_str = line.split("#", 1)
                                can_id_str = can_id_str.strip()
                                # Strip any non-hex chars from data
                                can_data_str = "".join(c for c in can_data_str.strip() if c in "0123456789abcdefABCDEF")
                                if not can_id_str or not can_data_str:
                                    continue
                                can_id = int(can_id_str, 16)
                                data_bytes = bytes.fromhex(can_data_str)
                                msg = can.Message(
                                    arbitration_id=can_id,
                                    data=data_bytes,
                                    is_extended_id=False,
                                )
                                await loop.run_in_executor(None, lambda m=msg: bus.send(m))
                                print(f"[serial] TX: {can_id_str}#{can_data_str.upper()}")
                            except (ValueError, can.CanError) as e:
                                print(f"[serial] TX parse error: {e} (line: {repr(line)})")
                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    print(f"[serial] ws_to_can error: {e}")
                finally:
                    bridge_open = False

            await asyncio.gather(can_to_ws(), ws_to_can())

            # Cleanup
            board = board_registry.get(board_id)
            if board:
                board.status = "offline"
                await update_board(board)
            try:
                bus.shutdown()
            except Exception:
                pass
            bus_manager.telemetry_detach(channel)

        else:
            # ── Serial/COM port mode (slcan, etc.) ──
            if not HAS_SERIAL:
                await websocket.send_json({"error": "pyserial not installed. Run: pip install pyserial"})
                await websocket.close()
                return

            com_port = config.get("com_port", "")
            baud_rate = int(config.get("baud_rate", 115200))

            if not com_port:
                await websocket.send_json({"error": "No COM port specified"})
                await websocket.close()
                return

            await websocket.send_json({"status": f"Opening {com_port} at {baud_rate} baud..."})

            try:
                ser = serial.Serial(
                    port=com_port, baudrate=baud_rate, timeout=0.1,
                    write_timeout=1, bytesize=serial.EIGHTBITS,
                    parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE,
                )
            except serial.SerialException as e:
                await websocket.send_json({"error": f"Failed to open {com_port}: {str(e)}"})
                await websocket.close()
                return

            await websocket.send_json({"status": "SERIAL_CONNECTED", "message": f"Serial Link on {com_port}"})

            board_id = f"USB:{com_port}"
            await register_board(board_id, com_port, baud_rate)

            line_buffer = ""

            async def serial_to_ws():
                nonlocal bridge_open, line_buffer
                loop = asyncio.get_event_loop()
                try:
                    while bridge_open and ser.is_open:
                        data = await loop.run_in_executor(None, lambda: ser.read(ser.in_waiting or 1))
                        if not data:
                            await asyncio.sleep(0.01)
                            continue

                        board = board_registry.get(board_id)
                        if board:
                            board.last_heartbeat = time.time()

                        text = data.decode("utf-8", errors="replace")
                        line_buffer += text

                        while "\n" in line_buffer:
                            line, line_buffer = line_buffer.split("\n", 1)
                            line = line.strip()
                            if not line:
                                continue

                            if "#" in line:
                                record_frame_bg(board_id, "rx", line)
                                can_id, can_data = line.split("#", 1)
                                if can_id.strip() == "200" and len(can_data.strip()) >= 2:
                                    try:
                                        input_byte = int(can_data.strip()[:2], 16)
                                        b = board_registry.get(board_id)
                                        if b:
                                            new_inputs = [bool(input_byte & (1 << i)) for i in range(4)]
                                            b.inputs = new_inputs
                                            b.last_heartbeat = time.time()
                                            log_state_bulk_bg(board_id, "input", new_inputs, "DI")
                                            await update_board(b)
                                    except ValueError:
                                        pass

                            frame = CrefFrame.decode(line)
                            if frame and frame.command == "REGISTER":
                                await register_board(frame.board_id, com_port, baud_rate)
                            elif frame and frame.command == "STATUS":
                                b = board_registry.get(frame.board_id)
                                if b:
                                    decode_board_state(frame.data, b)
                                    b.last_heartbeat = time.time()
                                    await update_board(b)

                        await websocket.send_json({
                            "message": data.hex(),
                            "format": "hex",
                            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        })
                except Exception as e:
                    print(f"[serial] serial_to_ws error: {e}")
                    bridge_open = False

            async def ws_to_serial():
                nonlocal bridge_open
                try:
                    while bridge_open and ser.is_open:
                        ws_msg = await websocket.receive()
                        if "bytes" in ws_msg and ws_msg["bytes"] is not None:
                            payload = ws_msg["bytes"]
                        elif "text" in ws_msg and ws_msg["text"] is not None:
                            payload = ws_msg["text"].encode()
                        else:
                            break
                        loop = asyncio.get_event_loop()
                        await loop.run_in_executor(None, lambda p=payload: ser.write(p))
                except Exception as e:
                    print(f"[serial] ws_to_serial error: {e}")
                    bridge_open = False

            await asyncio.gather(serial_to_ws(), ws_to_serial())

            board = board_registry.get(board_id)
            if board:
                board.status = "offline"
                await update_board(board)
            ser.close()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"error": str(e)})
        except Exception:
            pass
    finally:
        bridge_open = False
        try:
            await websocket.close()
        except Exception:
            pass
