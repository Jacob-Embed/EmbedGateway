"""
Multi-Board TCP Simulator
=========================
Simulates multiple hardware boards for testing.
Each board sends CREF REGISTER on connect, then periodic STATUS + HEARTBEAT.
Responds to CREF WRITE commands by updating its state.

Usage:
    python backend-py/tcp_server.py            # default: 3 boards on port 8001
    python backend-py/tcp_server.py --boards 5 # 5 boards
"""

import socket
import threading
import time
import random
import argparse


def encode_outputs(outputs):
    b0 = 0
    for i in range(min(8, len(outputs))):
        if outputs[i]: b0 |= 1 << i
    b1 = 0
    for i in range(8, min(12, len(outputs))):
        if outputs[i]: b1 |= 1 << (i - 8)
    return bytes([b0, b1])

def encode_inputs(inputs):
    b = 0
    for i in range(min(4, len(inputs))):
        if inputs[i]: b |= 1 << i
    return bytes([b])

def decode_outputs(data):
    result = []
    if len(data) < 1: return [False] * 12
    for i in range(8): result.append(bool(data[0] & (1 << i)))
    if len(data) >= 2:
        for i in range(4): result.append(bool(data[1] & (1 << i)))
    else:
        result.extend([False] * 4)
    return result


class SimBoard:
    def __init__(self, board_id):
        self.id = board_id
        self.outputs = [False] * 12
        self.inputs = [False] * 4

    def randomize_inputs(self):
        for i in range(4):
            if random.random() < 0.15:
                self.inputs[i] = not self.inputs[i]

    def state_bytes(self):
        return encode_outputs(self.outputs) + encode_inputs(self.inputs)

    def make_cref(self, cmd, data=b""):
        hex_data = data.hex().upper() if data else ""
        ts = int(time.time())
        ftype = "EVT" if cmd == "HEARTBEAT" else "RES"
        return f"CREF|{ftype}|{self.id}|{cmd}|{self.id}|{len(data):02X}|{hex_data}|{ts}"


def handle_client(conn, addr, boards):
    print(f"[server] Client connected from {addr}")

    for board in boards:
        reg = board.make_cref("REGISTER")
        conn.sendall((reg + "\n").encode())
        print(f"  -> Registered {board.id}")

    conn.setblocking(False)

    try:
        while True:
            for board in boards:
                board.randomize_inputs()
                status_frame = board.make_cref("STATUS", board.state_bytes())
                try:
                    conn.sendall((status_frame + "\n").encode())
                except BrokenPipeError:
                    raise ConnectionError("Client disconnected")

            # Check for incoming WRITE commands
            try:
                data = conn.recv(4096)
                if not data:
                    break
                for line in data.decode("utf-8", errors="replace").strip().split("\n"):
                    line = line.strip()
                    if not line:
                        continue
                    parts = line.split("|")
                    if len(parts) >= 8 and parts[0] == "CREF" and parts[3] == "WRITE":
                        board_id = parts[4]
                        hex_data = parts[6]
                        for board in boards:
                            if board.id == board_id and hex_data:
                                raw = bytes.fromhex(hex_data)
                                board.outputs = decode_outputs(raw)
                                print(f"  <- WRITE {board_id}: outputs={board.outputs}")
                                ack = board.make_cref("ACK", board.state_bytes())
                                conn.sendall((ack + "\n").encode())
            except BlockingIOError:
                pass

            for board in boards:
                hb = board.make_cref("HEARTBEAT")
                try:
                    conn.sendall((hb + "\n").encode())
                except BrokenPipeError:
                    raise ConnectionError("Client disconnected")

            time.sleep(2)

    except (ConnectionError, ConnectionResetError, OSError) as e:
        print(f"[server] Client {addr} disconnected: {e}")
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Multi-Board TCP Simulator")
    parser.add_argument("--boards", type=int, default=3, help="Number of boards to simulate")
    parser.add_argument("--port", type=int, default=8001, help="TCP port")
    args = parser.parse_args()

    boards = [SimBoard(f"B{i+1}") for i in range(args.boards)]
    print(f"[server] Simulating {len(boards)} boards: {[b.id for b in boards]}")

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", args.port))
    server.listen(5)
    print(f"[server] Listening on 127.0.0.1:{args.port}")
    print(f"[server] Connect via dashboard -> Connect page (ip: 127.0.0.1, port: {args.port})")

    try:
        while True:
            conn, addr = server.accept()
            t = threading.Thread(target=handle_client, args=(conn, addr, boards), daemon=True)
            t.start()
    except KeyboardInterrupt:
        print("\n[server] Shutting down")
        server.close()


if __name__ == "__main__":
    main()
