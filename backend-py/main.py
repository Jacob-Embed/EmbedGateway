"""CANGateway Backend — Entry point.
Run: python main.py
"""

import asyncio

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from boards.routes import router as boards_router
from connect.routes import router as connect_router
from status.routes import router as status_router
from config.routes import router as config_router
from logs.routes import router as logs_router
from history.routes import router as history_router
from serial_bridge import router as serial_router
from database import connect_db, disconnect_db, prune_history


RETENTION_DAYS = 30
PRUNE_INTERVAL_SEC = 24 * 60 * 60  # daily

app = FastAPI(title="CANGateway", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(status_router)
app.include_router(boards_router)
app.include_router(connect_router)
app.include_router(config_router)
app.include_router(logs_router)
app.include_router(history_router)
app.include_router(serial_router)


_prune_task: asyncio.Task | None = None


async def _prune_loop():
    while True:
        try:
            await prune_history(RETENTION_DAYS)
        except Exception as e:
            print(f"[prune] loop error: {e}")
        await asyncio.sleep(PRUNE_INTERVAL_SEC)


@app.on_event("startup")
async def startup():
    global _prune_task
    db_ok = False
    try:
        await connect_db()
        db_ok = True
    except Exception as e:
        print(f"[startup] DB connect failed — running without persistence: {e}")
    if db_ok:
        try:
            await prune_history(RETENTION_DAYS)
        except Exception as e:
            print(f"[startup] initial prune failed: {e}")
        _prune_task = asyncio.create_task(_prune_loop())
    suffix = " (DB connected)" if db_ok else " (DB OFFLINE — bridge & control only)"
    print(f"[startup] CANGateway backend ready{suffix}")
    print("[startup] Modules: boards, connect, config, logs, history, status, serial")


@app.on_event("shutdown")
async def shutdown():
    global _prune_task
    if _prune_task:
        _prune_task.cancel()
        try:
            await _prune_task
        except asyncio.CancelledError:
            pass
    try:
        await disconnect_db()
    except Exception as e:
        print(f"[shutdown] DB disconnect failed: {e}")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
