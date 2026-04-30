"""End-to-end TX->peer(echo)->RX roundtrip test for the /ws/tcp bridge.

Replicates the frontend encoders (handleDispatch) and the RX formatter
(formatRx) from src/pages/SendData.tsx so we can verify that what the
dashboard would display on RX is byte-identical to what the user typed
into TX, across all four Data Modes.
"""
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


# --- Frontend encoder replicas (handleDispatch) ---------------------------

def encode_tx(mode: str, raw: str):
    """Return what sendMessage() would put on the wire.

    - utf8  -> str (sent as a WS text frame)
    - hex/decimal/ascii -> bytes (sent as a WS binary frame)
    """
    raw = raw.strip()
    if mode == "utf8":
        return raw  # text frame
    if mode == "hex":
        stripped = raw.replace("0x", "").replace("0X", "").strip()
        tokens = stripped.split()
        return bytes(int(t, 16) for t in tokens)
    if mode == "decimal":
        return bytes(int(t, 10) for t in raw.split())
    if mode == "ascii":
        return bytes(ord(c) for c in raw)
    raise ValueError(f"unknown mode {mode}")


# --- Frontend RX formatter replica (formatRx) -----------------------------

def format_rx(mode: str, raw_hex: str) -> str:
    bytes_ = [int(raw_hex[i:i + 2], 16) for i in range(0, len(raw_hex), 2)]
    if not bytes_:
        return ""
    if mode == "hex":
        joined = " ".join(f"{b:02X}" for b in bytes_)
        return f"HEX: {joined} ({len(bytes_)} bytes)"
    if mode == "decimal":
        joined = " ".join(str(b) for b in bytes_)
        return f"DEC: {joined} ({len(bytes_)} bytes)"
    if mode == "ascii":
        joined = "".join(chr(b) if 32 <= b < 127 else "." for b in bytes_)
        return f"ASCII: {joined} ({len(bytes_)} bytes)"
    if mode == "utf8":
        # TextDecoder('utf-8', { fatal: false }) equivalent
        return bytes(bytes_).decode("utf-8", errors="replace")
    raise ValueError(f"unknown mode {mode}")


# --- Echo peer ------------------------------------------------------------

async def start_echo_server(port: int):
    async def handle(reader, writer):
        try:
            while True:
                data = await reader.read(4096)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    return await asyncio.start_server(handle, "127.0.0.1", port)


# --- Single test case -----------------------------------------------------

async def run_case(ws_port: int, tcp_port: int, mode: str, input_str: str,
                   expected_rx_hex: str, expected_formatted: str):
    payload = encode_tx(mode, input_str)
    tx_len = len(payload.encode("utf-8")) if isinstance(payload, str) else len(payload)

    async with websockets.connect(f"ws://127.0.0.1:{ws_port}/ws/tcp") as ws:
        await ws.send(json.dumps({"ip": "127.0.0.1", "port": tcp_port, "protocol": "tcp"}))

        # Drain status frames until BRIDGE_CONNECTED
        for _ in range(20):
            raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
            try:
                parsed = json.loads(raw)
            except Exception:
                continue
            if parsed.get("status") == "BRIDGE_CONNECTED":
                break

        # Send TX (text frame for utf8, binary frame otherwise)
        await ws.send(payload)

        # Await next data frame
        data_frame = None
        for _ in range(20):
            raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
            try:
                parsed = json.loads(raw)
            except Exception:
                continue
            if "status" in parsed:
                continue
            if "message" in parsed and parsed.get("format") == "hex":
                data_frame = parsed
                break

    if data_frame is None:
        return {
            "mode": mode, "input": input_str, "tx_len": tx_len,
            "rx_hex": "", "formatted": "<no frame>",
            "expected": expected_formatted, "ok": False,
        }

    rx_hex = data_frame["message"]
    formatted = format_rx(mode, rx_hex)
    ok = (rx_hex == expected_rx_hex) and (formatted == expected_formatted)
    return {
        "mode": mode, "input": input_str, "tx_len": tx_len,
        "rx_hex": rx_hex, "formatted": formatted,
        "expected": expected_formatted, "ok": ok,
    }


# --- Driver ---------------------------------------------------------------

async def run_test():
    tcp_port = find_free_port()
    ws_port = find_free_port()

    echo = await start_echo_server(tcp_port)

    config = uvicorn.Config(app, host="127.0.0.1", port=ws_port, log_level="error")
    server = uvicorn.Server(config)
    server_thread = threading.Thread(target=lambda: asyncio.run(server.serve()), daemon=True)
    server_thread.start()

    for _ in range(100):
        try:
            s = socket.create_connection(("127.0.0.1", ws_port), timeout=0.2)
            s.close()
            break
        except OSError:
            await asyncio.sleep(0.05)

    cases = [
        ("hex",     "11 21 FF",     "1121ff",     "HEX: 11 21 FF (3 bytes)"),
        ("decimal", "112 111 200",  "706fc8",     "DEC: 112 111 200 (3 bytes)"),
        ("ascii",   "Hi!",          "486921",     "ASCII: Hi! (3 bytes)"),
        ("utf8",    "hello",        "68656c6c6f", "hello"),
    ]

    results = []
    try:
        for mode, inp, exp_hex, exp_fmt in cases:
            res = await run_case(ws_port, tcp_port, mode, inp, exp_hex, exp_fmt)
            tag = "PASS" if res["ok"] else "FAIL"
            print(f"[{tag}] mode={res['mode']:<7} input={res['input']!r:<14} "
                  f"tx={res['tx_len']}B rx_hex={res['rx_hex']!r} "
                  f"formatted={res['formatted']!r} expected={res['expected']!r}")
            results.append(res)
    finally:
        try:
            server.should_exit = True
        except Exception:
            pass
        echo.close()
        await echo.wait_closed()

    print("\n=== BRIDGE TX->PEER->RX ROUNDTRIP SUMMARY ===")
    print(f"{'MODE':<8} {'INPUT':<14} {'TX':>4} {'RX_HEX':<14} {'RESULT':<6} FORMATTED")
    all_ok = True
    for r in results:
        tag = "PASS" if r["ok"] else "FAIL"
        if not r["ok"]:
            all_ok = False
        print(f"{r['mode']:<8} {r['input']:<14} {r['tx_len']:>3}B {r['rx_hex']:<14} {tag:<6} {r['formatted']}")
    print("=============================================")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run_test()))
