"""End-to-end byte-exactness test for the /ws/tcp bridge."""
import asyncio
import json
import socket
import sys
import threading
import time

import uvicorn
import websockets

from main import app


def find_free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Collector:
    def __init__(self):
        self.buf = bytearray()
        self.server = None
        self.lock = threading.Lock()

    async def handle(self, reader, writer):
        while True:
            data = await reader.read(4096)
            if not data:
                break
            with self.lock:
                self.buf.extend(data)

    def snapshot_and_clear(self) -> bytes:
        with self.lock:
            out = bytes(self.buf)
            self.buf.clear()
        return out


async def wait_bytes(collector: Collector, n: int, timeout: float = 3.0) -> bytes:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with collector.lock:
            if len(collector.buf) >= n:
                break
        await asyncio.sleep(0.02)
    return collector.snapshot_and_clear()


async def run_test():
    tcp_port = find_free_port()
    ws_port = find_free_port()

    collector = Collector()
    tcp_server = await asyncio.start_server(collector.handle, "127.0.0.1", tcp_port)

    # Start uvicorn in a background thread
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

    results = []
    try:
        async with websockets.connect(f"ws://127.0.0.1:{ws_port}/ws/tcp") as ws:
            await ws.send(json.dumps({"ip": "127.0.0.1", "port": tcp_port, "protocol": "tcp"}))

            # Drain status messages until BRIDGE_CONNECTED
            for _ in range(10):
                msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                try:
                    parsed = json.loads(msg)
                except Exception:
                    parsed = {}
                if parsed.get("status") == "BRIDGE_CONNECTED":
                    break

            cases = [
                ("BINARY 0x11 0x11",            bytes([0x11, 0x11]),        b"\x11\x11"),
                ("BINARY 0x11 0x21 0x11",       bytes([0x11, 0x21, 0x11]),  b"\x11\x21\x11"),
                ("BINARY 200 255 0 (UTF-8 trap)", bytes([200, 255, 0]),     b"\xc8\xff\x00"),
                ("TEXT 'hello' (no newline)",   "hello",                    b"hello"),
            ]

            for name, payload, expected in cases:
                await ws.send(payload)
                got = await wait_bytes(collector, len(expected), timeout=3.0)
                ok = got == expected
                results.append((name, ok, len(expected), len(got), expected, got))
    finally:
        try:
            server.should_exit = True
        except Exception:
            pass
        tcp_server.close()
        await tcp_server.wait_closed()

    # Report
    print("\n=== BRIDGE BYTE-EXACTNESS RESULTS ===")
    all_ok = True
    for name, ok, exp_len, got_len, expected, got in results:
        tag = "PASS" if ok else "FAIL"
        if not ok:
            all_ok = False
        print(f"[{tag}] {name}: expected {exp_len}B {expected!r}, got {got_len}B {got!r}")
    print("=====================================")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run_test()))
