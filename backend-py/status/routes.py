"""System status endpoints."""

from fastapi import APIRouter
from boards.service import board_registry

router = APIRouter(tags=["status"])


@router.get("/")
async def root():
    return {"message": "CANGateway Backend Running"}


@router.get("/status")
async def get_status():
    online = sum(1 for b in board_registry.values() if b.status == "online")
    return {
        "total_boards": len(board_registry),
        "online": online,
        "offline": len(board_registry) - online,
    }
