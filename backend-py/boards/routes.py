"""Board REST + WebSocket endpoints."""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import List

from .service import board_registry, board_writers, get_all_boards, get_board, update_board
from protocol import encode_outputs
from websocket import ws_manager
from history_recorder import log_state_bulk_bg, log_state_change_bg, record_frame_bg

router = APIRouter(tags=["boards"])


@router.get("/boards")
async def list_boards():
    return get_all_boards()


@router.get("/boards/{board_id}")
async def get_board_detail(board_id: str):
    board = get_board(board_id)
    if not board: return {"error": "Board not found"}
    return board.to_dict()


class ToggleCommand(BaseModel):
    board_id: str
    output_index: int
    value: bool


@router.post("/toggle")
async def toggle_output(cmd: ToggleCommand):
    board = get_board(cmd.board_id)
    if not board: return {"error": "Board not found"}
    if cmd.output_index < 0 or cmd.output_index >= 15:
        return {"error": "output_index must be 0-14"}

    board.outputs[cmd.output_index] = cmd.value
    log_state_change_bg(cmd.board_id, "output", cmd.output_index, cmd.value,
                        f"DO{cmd.output_index + 1}")
    writer = board_writers.get(cmd.board_id)
    if writer:
        data = encode_outputs(board.outputs)
        try:
            frame = f"100#{data.hex().upper()}"
            writer.write((frame + "\n").encode())
            await writer.drain()
            record_frame_bg(cmd.board_id, "tx", frame)
        except Exception as e:
            print(f"[boards] TCP send error: {e}")

    await update_board(board)
    return {"status": "ok", "board": board.to_dict()}


class WriteCommand(BaseModel):
    board_id: str
    outputs: List[bool]


@router.post("/send")
async def send_outputs(cmd: WriteCommand):
    board = get_board(cmd.board_id)
    if not board: return {"error": "Board not found"}

    board.outputs = cmd.outputs[:15]
    log_state_bulk_bg(cmd.board_id, "output", board.outputs, "DO")
    writer = board_writers.get(cmd.board_id)
    if writer:
        data = encode_outputs(board.outputs)
        try:
            frame = f"100#{data.hex().upper()}"
            writer.write((frame + "\n").encode())
            await writer.drain()
            record_frame_bg(cmd.board_id, "tx", frame)
        except Exception as e:
            print(f"[boards] TCP send error: {e}")

    await update_board(board)
    return {"status": "sent", "board": board.to_dict()}


@router.websocket("/ws/boards")
async def ws_boards(websocket: WebSocket):
    await websocket.accept()
    await ws_manager.add(websocket)
    await websocket.send_json({"type": "boards_list", "boards": get_all_boards()})

    try:
        while True:
            msg = await websocket.receive_json()
            cmd = msg.get("command")

            if cmd == "toggle":
                board = get_board(msg.get("board_id", ""))
                if board:
                    idx = msg.get("output_index", 0)
                    if 0 <= idx < 15:
                        val = bool(msg.get("value", False))
                        board.outputs[idx] = val
                        log_state_change_bg(board.id, "output", idx, val, f"DO{idx + 1}")
                        writer = board_writers.get(board.id)
                        if writer:
                            data = encode_outputs(board.outputs)
                            try:
                                frame = f"100#{data.hex().upper()}"
                                writer.write((frame + "\n").encode())
                                await writer.drain()
                                record_frame_bg(board.id, "tx", frame)
                            except Exception: pass
                        await update_board(board)

            elif cmd == "write":
                board = get_board(msg.get("board_id", ""))
                if board:
                    board.outputs = msg.get("outputs", board.outputs)[:15]
                    log_state_bulk_bg(board.id, "output", board.outputs, "DO")
                    writer = board_writers.get(board.id)
                    if writer:
                        data = encode_outputs(board.outputs)
                        try:
                            frame = f"100#{data.hex().upper()}"
                            writer.write((frame + "\n").encode())
                            await writer.drain()
                            record_frame_bg(board.id, "tx", frame)
                        except Exception: pass
                    await update_board(board)

            elif cmd == "refresh":
                await websocket.send_json({"type": "boards_list", "boards": get_all_boards()})

    except WebSocketDisconnect: pass
    except Exception as e:
        print(f"[ws/boards] error: {e}")
    finally:
        ws_manager.remove(websocket)
