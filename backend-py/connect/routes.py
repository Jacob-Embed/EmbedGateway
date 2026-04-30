"""TCP/UDP bridge — WebSocket endpoint for browser-mode hardware connections."""

import time
import asyncio
import socket
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from protocol import CrefFrame, decode_board_state
from boards.service import board_registry, register_board, update_board
from history_recorder import log_state_bulk_bg, record_frame_bg

router = APIRouter(tags=["connect"])


@router.websocket("/ws/tcp")
async def websocket_tcp_bridge(websocket: WebSocket):
    await websocket.accept()
    bridge_open = True

    try:
        config = await websocket.receive_json()
        target_ip = config.get("ip", "127.0.0.1")
        target_port = int(config.get("port", 8001))
        protocol = config.get("protocol", "tcp").lower()

        await websocket.send_json({"status": f"Linking {protocol.upper()} Core..."})

        if protocol == "tcp":
            reader, writer = None, None
            for i in range(5):
                try:
                    reader, writer = await asyncio.open_connection(target_ip, target_port)
                    break
                except Exception:
                    await websocket.send_json({"status": f"Retrying Hardware ({i+1}/5)..."})
                    await asyncio.sleep(1)

            if not reader or not writer:
                raise Exception("Hardware unreachable.")

            await websocket.send_json({"status": "BRIDGE_CONNECTED", "message": "Hardware Link Established"})

            # Auto-register board
            board_id = f"{target_ip}:{target_port}"
            await register_board(board_id, target_ip, target_port, writer)
            print(f"[connect] Board {board_id} registered")

            async def tcp_to_ws():
                nonlocal bridge_open
                try:
                    while bridge_open:
                        data = await reader.read(1024)
                        if not data: break

                        board = board_registry.get(board_id)
                        if board:
                            board.last_heartbeat = time.time()

                        # Parse CAN frames + CREF
                        text = data.decode("utf-8", errors="replace").strip()
                        for line in text.split("\n"):
                            line = line.strip()
                            if not line: continue

                            # Parse CAN frame: 200#XX → update inputs
                            if "#" in line:
                                can_id, can_data = line.split("#", 1)
                                can_id = can_id.strip()
                                can_data = can_data.strip()
                                record_frame_bg(board_id, "rx", line)
                                if can_id == "200" and len(can_data) >= 2:
                                    try:
                                        input_byte = int(can_data[:2], 16)
                                        b = board_registry.get(board_id)
                                        if b:
                                            new_inputs = [bool(input_byte & (1 << i)) for i in range(4)]
                                            b.inputs = new_inputs
                                            b.last_heartbeat = time.time()
                                            log_state_bulk_bg(board_id, "input", new_inputs, "DI")
                                            await update_board(b)
                                    except ValueError:
                                        pass

                            # Try CREF parsing
                            frame = CrefFrame.decode(line)
                            if frame and frame.command == "REGISTER":
                                await register_board(frame.board_id, target_ip, target_port, writer)
                            elif frame and frame.command == "STATUS":
                                b = board_registry.get(frame.board_id)
                                if b:
                                    decode_board_state(frame.data, b)
                                    b.last_heartbeat = time.time()
                                    await update_board(b)
                            elif frame and frame.command == "HEARTBEAT":
                                b = board_registry.get(frame.board_id)
                                if b:
                                    b.last_heartbeat = time.time()
                                    b.status = "online"

                        # Forward raw hex to WS client
                        await websocket.send_json({
                            "message": data.hex(),
                            "format": "hex",
                            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        })
                except Exception as e:
                    print(f"[connect] tcp_to_ws error: {e}")
                    bridge_open = False

            async def ws_to_tcp():
                nonlocal bridge_open
                try:
                    while bridge_open:
                        ws_msg = await websocket.receive()
                        if "bytes" in ws_msg and ws_msg["bytes"] is not None:
                            payload = ws_msg["bytes"]
                        elif "text" in ws_msg and ws_msg["text"] is not None:
                            payload = ws_msg["text"].encode()
                        else: break
                        writer.write(payload)
                        await writer.drain()
                except Exception as e:
                    print(f"[connect] ws_to_tcp error: {e}")
                    bridge_open = False

            await asyncio.gather(tcp_to_ws(), ws_to_tcp())

            board = board_registry.get(board_id)
            if board:
                board.status = "offline"
                await update_board(board)
            writer.close()

        elif protocol == "udp":
            udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            udp_sock.setblocking(False)
            addr = (target_ip, target_port)
            udp_sock.sendto(b"BRIDGE_CONNECT\n", addr)
            await websocket.send_json({"status": "UDP_BRIDGE_ACTIVE"})

            async def udp_to_ws():
                nonlocal bridge_open
                loop = asyncio.get_event_loop()
                try:
                    while bridge_open:
                        data, _ = await loop.sock_recvfrom(udp_sock, 1024)
                        await websocket.send_json({
                            "message": data.hex(), "format": "hex",
                            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        })
                except Exception: bridge_open = False

            async def ws_to_udp():
                nonlocal bridge_open
                loop = asyncio.get_event_loop()
                try:
                    while bridge_open:
                        ws_msg = await websocket.receive()
                        if "bytes" in ws_msg and ws_msg["bytes"] is not None:
                            payload = ws_msg["bytes"]
                        elif "text" in ws_msg and ws_msg["text"] is not None:
                            payload = ws_msg["text"].encode()
                        else: break
                        await loop.sock_sendto(udp_sock, payload, addr)
                except Exception: bridge_open = False

            await asyncio.gather(udp_to_ws(), ws_to_udp())
            udp_sock.close()

    except WebSocketDisconnect: pass
    except Exception as e:
        try: await websocket.send_json({"error": str(e)})
        except Exception: pass
    finally:
        bridge_open = False
        try: await websocket.close()
        except Exception: pass
