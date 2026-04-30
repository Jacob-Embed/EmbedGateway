"""End-to-end RX test for the /ws/tcp bridge: TCP peer -> WS client as hex."""
import asyncio
import json
import socket
import sys
import threading

import uvicorn
import websockets

from main import app


def find_free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


async def run_case(ws_port: int, payload: bytes, expected_hex: str, name: str):
    tcp_port = find_free_port()
    ready = asyncio.Event()

    async def handle(reader, writer):
        writer.write(payload)
        await writer.drain()
        # keep open briefly so WS has time to forward
        try:
            await asyncio.sleep(0.5)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    tcp_server = await asyncio.start_server(handle, "127.0.0.1", tcp_port)

    try:
        async with websockets.connect(f"ws://127.0.0.1:{ws_port}/ws/tcp") as ws:
            await ws.send(json.dumps({"ip": "127.0.0.1", "port": tcp_port, "protocol": "tcp"}))

            data_frame = None
            # Drain status frames until we see a frame with a "message" key that is NOT a status
            for _ in range(20):
                raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                try:
                    parsed = json.loads(raw)
                except Exception:
                    continue
                if "status" in parsed:
                    # status frames may also carry "message" (e.g. BRIDGE_CONNECTED). skip them.
                    continue
                if "message" in parsed:
                    data_frame = parsed
                    break

        if data_frame is None:
            return (name, False, "no data frame", "")
        got_msg = data_frame.get("message")
        got_fmt = data_frame.get("format")
        ok = got_msg == expected_hex and got_fmt == "hex"
        detail = f"message={got_msg!r} format={got_fmt!r}"
        return (name, ok, expected_hex, detail)
    finally:
        tcp_server.close()
        await tcp_server.wait_closed()


async def run_test():
    ws_port = find_free_port()

    config = uvicorn.Config(app, host="127.0.0.1", port=ws_port, log_level="error")
    server = uvicorn.Server(config)
    server_thread = threading.Thread(target=lambda: asyncio.run(server.serve()), daemon=True)
    server_thread.start()

    # Wait for uvicorn ready
    for _ in range(100):
        try:
            s = socket.create_connection(("127.0.0.1", ws_port), timeout=0.2)
            s.close()
            break
        except OSError:
            await asyncio.sleep(0.05)

    cases = [
        ("RX 0x11 0x21 0xFF",            bytes([0x11, 0x21, 0xFF]), "1121ff"),
        ("RX 0xC8 0xFF 0x00 (UTF-8 trap)", bytes([0xC8, 0xFF, 0x00]), "c8ff00"),
        ("RX b'hello'",                   b"hello",                   "68656c6c6f"),
    ]

    results = []
    try:
        for name, payload, expected in cases:
            res = await run_case(ws_port, payload, expected, name)
            results.append(res)
    finally:
        try:
            server.should_exit = True
        except Exception:
            pass

    print("\n=== BRIDGE RX HEX RESULTS ===")
    print(f"{'CASE':<36} {'RESULT':<6} {'EXPECTED':<14} DETAIL")
    all_ok = True
    for name, ok, expected, detail in results:
        tag = "PASS" if ok else "FAIL"
        if not ok:
            all_ok = False
        print(f"{name:<36} {tag:<6} {expected:<14} {detail}")
    print("=============================")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run_test()))
