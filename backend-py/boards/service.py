"""Board registry — in-memory store of all connected hardware boards."""

import asyncio
from typing import Dict
from protocol import Board
from websocket import ws_manager

board_registry: Dict[str, Board] = {}
board_writers: Dict[str, asyncio.StreamWriter] = {}


async def register_board(board_id: str, ip: str, port: int, writer=None) -> Board:
    if board_id in board_registry:
        board = board_registry[board_id]
        board.status = "online"
        board.ip = ip
        board.port = port
    else:
        board = Board(id=board_id, status="online", ip=ip, port=port)
        board_registry[board_id] = board

    if writer:
        board_writers[board_id] = writer

    await ws_manager.broadcast({"type": "boards_list", "boards": get_all_boards()})
    return board


async def update_board(board: Board):
    await ws_manager.broadcast({"type": "board_update", "board": board.to_dict()})


def get_all_boards():
    return [b.to_dict() for b in board_registry.values()]


def get_board(board_id: str):
    return board_registry.get(board_id)
