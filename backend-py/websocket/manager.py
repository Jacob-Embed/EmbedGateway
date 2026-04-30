"""WebSocket broadcast manager — pushes board updates to all UI clients."""

from fastapi import WebSocket
from typing import List


class WebSocketManager:
    def __init__(self):
        self.clients: List[WebSocket] = []

    async def add(self, ws: WebSocket):
        self.clients.append(ws)

    def remove(self, ws: WebSocket):
        if ws in self.clients:
            self.clients.remove(ws)

    async def broadcast(self, data: dict):
        dead = []
        for ws in self.clients:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.remove(ws)


ws_manager = WebSocketManager()
