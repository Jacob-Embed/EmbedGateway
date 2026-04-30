"""
CREF Protocol + CAN Frame Helpers
===================================
Hardware spec:
  RX → Output Control: CAN ID 0x100, 2 bytes, 15 digital outputs (DO1-DO15)
  TX ← Input Status:   CAN ID 0x200, 1 byte,  4 digital inputs  (DI1-DI4)

Example: Turn on DO1, DO3, DO6 → send 100#1500
"""

import time
from dataclasses import dataclass, field
from typing import List, Optional

CAN_OUTPUT_ID = "100"
CAN_INPUT_ID = "200"


@dataclass
class Board:
    id: str
    outputs: List[bool] = field(default_factory=lambda: [False] * 15)
    inputs: List[bool] = field(default_factory=lambda: [False] * 4)
    status: str = "offline"
    ip: str = ""
    port: int = 0
    last_heartbeat: float = 0.0

    def to_dict(self):
        return {
            "id": self.id, "outputs": self.outputs, "inputs": self.inputs,
            "status": self.status, "ip": self.ip, "port": self.port,
            "last_heartbeat": self.last_heartbeat,
        }


def encode_outputs(outputs: List[bool]) -> bytes:
    """15 bools → 2 bytes."""
    b0 = 0
    for i in range(min(8, len(outputs))):
        if outputs[i]: b0 |= 1 << i
    b1 = 0
    for i in range(8, min(15, len(outputs))):
        if outputs[i]: b1 |= 1 << (i - 8)
    return bytes([b0, b1])


def decode_outputs(data: bytes) -> List[bool]:
    """2 bytes → 15 bools."""
    result = []
    if len(data) < 1: return [False] * 15
    for i in range(8): result.append(bool(data[0] & (1 << i)))
    if len(data) >= 2:
        for i in range(7): result.append(bool(data[1] & (1 << i)))
    else:
        result.extend([False] * 7)
    return result[:15]


def decode_inputs(data: bytes) -> List[bool]:
    """1 byte → 4 bools."""
    if len(data) < 1: return [False] * 4
    return [bool(data[0] & (1 << i)) for i in range(4)]


def encode_board_state(board: Board) -> bytes:
    inp = 0
    for i in range(min(4, len(board.inputs))):
        if board.inputs[i]: inp |= 1 << i
    return encode_outputs(board.outputs) + bytes([inp])


def decode_board_state(data: bytes, board: Board):
    if len(data) >= 2: board.outputs = decode_outputs(data[0:2])
    if len(data) >= 3: board.inputs = decode_inputs(data[2:3])


@dataclass
class CrefFrame:
    type: str
    client_id: str
    command: str
    board_id: str
    length: int = 0
    data: bytes = b""
    timestamp: int = 0

    def encode(self) -> str:
        hex_data = self.data.hex().upper() if self.data else ""
        ts = self.timestamp or int(time.time())
        return f"CREF|{self.type}|{self.client_id}|{self.command}|{self.board_id}|{len(self.data):02X}|{hex_data}|{ts}"

    @staticmethod
    def decode(raw: str) -> Optional["CrefFrame"]:
        parts = raw.strip().split("|")
        if len(parts) < 8 or parts[0] != "CREF": return None
        try:
            data_hex = parts[6]
            data = bytes.fromhex(data_hex) if data_hex else b""
            return CrefFrame(
                type=parts[1], client_id=parts[2], command=parts[3],
                board_id=parts[4], length=int(parts[5], 16),
                data=data, timestamp=int(parts[7]),
            )
        except (ValueError, IndexError):
            return None
