"""
Live demo: simulates the frontend talking to the Python bridge while a real
TCP peer streams hex data back. Prints every TX and RX line as the SendData
page would render them, so you can verify the live feed end-to-end without
opening a browser.
"""
import asyncio
import json
import sys
import threading
import time
import contextlib

# Force stdout to UTF-8 so non-ASCII bytes from the peer (e.g. 0xDE 0xAD ...)
# don't crash Windows' cp1252 console when rendered in UTF-8 mode.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

import uvicorn
import websockets
from main import app


def fmt_rx(hex_str: str, mode: str) -> str:
    bs = bytes.fromhex(hex_str)
    if mode == "hex":
        return f"HEX: {' '.join(f'{b:02X}' for b in bs)} ({len(bs)} bytes)"
    if mode == "decimal":
        return f"DEC: {' '.join(str(b) for b in bs)} ({len(bs)} bytes)"
    if mode == "ascii":
        s = ''.join(chr(b) if 32 <= b < 127 else '.' for b in bs)
        return f"ASCII: {s} ({len(bs)} bytes)"
    return bs.decode("utf-8", errors="replace")


def fmt_tx(bs: bytes, mode: str) -> str:
    if mode == "hex":
        return f"HEX: {' '.join(f'{b:02X}' for b in bs)} ({len(bs)} bytes)"
    if mode == "decimal":
        return f"DEC: {' '.join(str(b) for b in bs)} ({len(bs)} bytes)"
    if mode == "ascii":
        return f"ASCII: {bs.decode('latin-1')} ({len(bs)} bytes)"
    return bs.decode("utf-8", errors="replace")


async def tcp_peer(host: str, port_holder: list):
    """Real TCP peer: echoes whatever it receives, and also pushes one
    unsolicited hex packet 0.4s after a client connects to prove the RX-only
    path works too."""
    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        print("[peer ] client connected")
        async def push_unsolicited():
            await asyncio.sleep(0.4)
            payload = bytes([0xDE, 0xAD, 0xBE, 0xEF])
            print(f"[peer ] unsolicited push -> {payload.hex()}")
            writer.write(payload)
            await writer.drain()
        asyncio.create_task(push_unsolicited())
        try:
            while True:
                data = await reader.read(1024)
                if not data:
                    break
                print(f"[peer ] received  {data.hex()} ({len(data)}B) -> echoing")
                writer.write(data)
                await writer.drain()
        except Exception as e:
            print(f"[peer ] error: {e}")
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    server = await asyncio.start_server(handler, host, 0)
    port = server.sockets[0].getsockname()[1]
    port_holder.append(port)
    print(f"[peer ] listening on {host}:{port}")
    async with server:
        await server.serve_forever()


def start_uvicorn() -> uvicorn.Server:
    config = uvicorn.Config(app, host="127.0.0.1", port=8000, log_level="warning")
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    # wait until ready
    for _ in range(50):
        if server.started:
            return server
        time.sleep(0.1)
    raise RuntimeError("uvicorn did not start")


async def frontend(peer_port: int):
    """Simulates TcpContext + SendData."""
    uri = "ws://localhost:8000/ws/tcp"
    async with websockets.connect(uri) as ws:
        cfg = {"ip": "127.0.0.1", "port": str(peer_port), "protocol": "tcp"}
        print(f"[front] connecting via bridge -> {cfg}")
        await ws.send(json.dumps(cfg))

        # Drain status frames until BRIDGE_CONNECTED.
        while True:
            raw = await ws.recv()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("status") == "BRIDGE_CONNECTED":
                print("[front] BRIDGE_CONNECTED")
                break
            if "status" in msg:
                print(f"[front] status: {msg['status']}")

        async def reader_task():
            try:
                while True:
                    raw = await ws.recv()
                    msg = json.loads(raw)
                    if "message" in msg and msg.get("format") == "hex":
                        for mode in ("hex", "decimal", "ascii", "utf8"):
                            print(f"[ rx  ] mode={mode:<7} -> {fmt_rx(msg['message'], mode)}")
                        print(flush=True)
                    else:
                        print(f"[ rx? ] non-data frame: {msg}", flush=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[ rx  ] reader_task error: {type(e).__name__}: {e}", flush=True)

        rt = asyncio.create_task(reader_task())

        # Three TX bursts in different modes.
        bursts = [
            ("hex",     bytes([0x11, 0x21, 0xFF])),
            ("decimal", bytes([112, 111, 200])),
            ("ascii",   b"Hi!"),
        ]
        # Give the unsolicited peer push time to arrive first.
        await asyncio.sleep(0.7)

        for mode, payload in bursts:
            print(f"[ tx  ] {fmt_tx(payload, mode)}")
            await ws.send(payload)  # binary frame
            await asyncio.sleep(0.4)

        # Let the last echo arrive.
        await asyncio.sleep(0.5)
        rt.cancel()
        with contextlib.suppress(Exception):
            await rt


async def main():
    port_holder: list = []
    peer = asyncio.create_task(tcp_peer("127.0.0.1", port_holder))
    # wait for peer to bind
    while not port_holder:
        await asyncio.sleep(0.05)
    peer_port = port_holder[0]

    server = start_uvicorn()
    try:
        await frontend(peer_port)
    finally:
        server.should_exit = True
        peer.cancel()
        with contextlib.suppress(Exception):
            await peer


if __name__ == "__main__":
    asyncio.run(main())
