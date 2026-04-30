"""Integration test: verify the FastAPI TCP bridge handles a reconnect
using a non-default (persisted) endpoint, as the frontend now does via
localStorage-backed auto-reconnect."""
import asyncio
import json
import socket
import threading
import time
import sys
import os

import uvicorn
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from main import app


def pick_free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def run_echo_server(host: str, port: int, stop_event: asyncio.Event):
    async def handle(reader, writer):
        try:
            while True:
                data = await reader.read(1024)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    server = await asyncio.start_server(handle, host, port)
    async with server:
        await stop_event.wait()
        server.close()
        await server.wait_closed()


def start_echo_server_thread(host: str, port: int):
    ready = threading.Event()
    loop_holder = {}
    stop_holder = {}

    def runner():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        stop_event = asyncio.Event()
        loop_holder["loop"] = loop
        stop_holder["stop"] = stop_event
        ready.set()
        loop.run_until_complete(run_echo_server(host, port, stop_event))
        loop.close()

    t = threading.Thread(target=runner, daemon=True)
    t.start()
    ready.wait()
    # Wait until port is actually listening
    for _ in range(50):
        try:
            with socket.create_connection((host, port), timeout=0.2):
                break
        except Exception:
            time.sleep(0.1)
    return loop_holder, stop_holder, t


class UvicornServerThread(threading.Thread):
    def __init__(self, app, host, port):
        super().__init__(daemon=True)
        config = uvicorn.Config(app, host=host, port=port, log_level="warning")
        self.server = uvicorn.Server(config)

    def run(self):
        self.server.run()

    def stop(self):
        self.server.should_exit = True


def wait_for_http(host, port, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except Exception:
            time.sleep(0.1)
    return False


async def drain_until_bridge_connected(ws, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get("status") == "BRIDGE_CONNECTED":
            return
    raise TimeoutError("Did not reach BRIDGE_CONNECTED")


async def read_rx_frame(ws, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get("message") is not None and msg.get("format") == "hex":
            return msg
    raise TimeoutError("No RX frame")


async def run_test(echo_port: int, api_port: int):
    config_payload = {
        "ip": "127.0.0.1",
        "port": str(echo_port),
        "protocol": "tcp",
    }
    assert echo_port != 8001, "echo port must not be default 8001"

    ws_url = f"ws://localhost:{api_port}/ws/tcp"

    # --- WS #1 ---
    async with websockets.connect(ws_url) as ws1:
        await ws1.send(json.dumps(config_payload))
        await drain_until_bridge_connected(ws1)
        await ws1.send(bytes([0xAB, 0xCD]))
        rx = await read_rx_frame(ws1)
        assert rx["message"] == "abcd", f"WS#1 expected 'abcd', got {rx['message']!r}"
        print("WS#1 RX ok:", rx["message"])

    # --- WS #2 (simulated refresh -> auto-reconnect with persisted endpoint) ---
    await asyncio.sleep(0.3)
    async with websockets.connect(ws_url) as ws2:
        await ws2.send(json.dumps(config_payload))
        await drain_until_bridge_connected(ws2)
        await ws2.send(bytes([0x01, 0x02, 0x03]))
        rx = await read_rx_frame(ws2)
        assert rx["message"] == "010203", f"WS#2 expected '010203', got {rx['message']!r}"
        print("WS#2 RX ok:", rx["message"])


def main():
    echo_port = pick_free_port()
    api_port = pick_free_port()
    while api_port == echo_port:
        api_port = pick_free_port()

    print(f"echo_port={echo_port} api_port={api_port}")

    loop_holder, stop_holder, echo_thread = start_echo_server_thread("127.0.0.1", echo_port)

    uv = UvicornServerThread(app, "127.0.0.1", api_port)
    uv.start()
    try:
        if not wait_for_http("127.0.0.1", api_port, timeout=10):
            raise RuntimeError("uvicorn did not come up")
        asyncio.run(run_test(echo_port, api_port))
        print("PASS: bridge reconnect test")
        return 0
    except Exception as e:
        print(f"FAIL: {e}")
        import traceback
        traceback.print_exc()
        return 1
    finally:
        uv.stop()
        try:
            loop = loop_holder.get("loop")
            stop_event = stop_holder.get("stop")
            if loop and stop_event:
                loop.call_soon_threadsafe(stop_event.set)
        except Exception:
            pass
        time.sleep(0.3)


if __name__ == "__main__":
    sys.exit(main())
