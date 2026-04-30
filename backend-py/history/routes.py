"""Historical data endpoints — JSON + CSV downloads of CommLog and SensorReading."""

import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from database import (
    get_board_log_history, get_frame_history, get_sensor_history, prune_history,
)

router = APIRouter(tags=["history"])


def _parse_range(days: Optional[int], start: Optional[str], end: Optional[str]):
    """Returns (start_dt, end_dt). Priority: explicit start/end > days > default 1d."""
    now = datetime.now(timezone.utc)
    if start and end:
        try:
            s = datetime.fromisoformat(start.replace("Z", "+00:00"))
            e = datetime.fromisoformat(end.replace("Z", "+00:00"))
            return s, e
        except ValueError:
            pass
    span_days = days if days is not None else 1
    span_days = max(1, min(30, span_days))
    return now - timedelta(days=span_days), now


# ── Sensor history ─────────────────────────────────────────────────────

@router.get("/history/sensors")
async def sensors_history(
    board_id: str,
    can_id: Optional[str] = None,
    days: Optional[int] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = Query(50000, le=100000),
):
    s, e = _parse_range(days, start, end)
    rows = await get_sensor_history(board_id, s, e, can_id, limit)
    return {"board_id": board_id, "start": s.isoformat(), "end": e.isoformat(),
            "count": len(rows), "rows": rows}


@router.get("/history/sensors.csv")
async def sensors_history_csv(
    board_id: str,
    can_id: Optional[str] = None,
    days: Optional[int] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = Query(100000, le=200000),
):
    s, e = _parse_range(days, start, end)
    rows = await get_sensor_history(board_id, s, e, can_id, limit)

    max_vals = max((len(r["values"]) for r in rows), default=0)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "board_id", "can_id"] +
               [f"byte{i}" for i in range(max_vals)])
    for r in rows:
        vals = r["values"] + [""] * (max_vals - len(r["values"]))
        w.writerow([r["timestamp"], r["board_id"], r["can_id"], *vals])

    fname = f"sensors_{board_id}_{s.date()}_{e.date()}.csv".replace(":", "-")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── Frame (CommLog) history ────────────────────────────────────────────

@router.get("/history/frames")
async def frames_history(
    board_id: str,
    direction: Optional[str] = None,
    days: Optional[int] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = Query(10000, le=50000),
):
    s, e = _parse_range(days, start, end)
    rows = await get_frame_history(board_id, s, e, direction, limit)
    return {"board_id": board_id, "start": s.isoformat(), "end": e.isoformat(),
            "count": len(rows), "rows": rows}


@router.get("/history/frames.csv")
async def frames_history_csv(
    board_id: str,
    direction: Optional[str] = None,
    days: Optional[int] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = Query(50000, le=200000),
):
    s, e = _parse_range(days, start, end)
    rows = await get_frame_history(board_id, s, e, direction, limit)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "board_id", "direction", "raw_frame"])
    for r in rows:
        w.writerow([r["timestamp"], r["board_id"], r["direction"], r["raw_frame"]])

    fname = f"frames_{board_id}_{s.date()}_{e.date()}.csv".replace(":", "-")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── Board state log (inputs + outputs) ────────────────────────────────

@router.get("/history/boardlogs")
async def boardlogs_history(
    board_id: str,
    log_type: Optional[str] = None,  # "input" | "output"
    days: Optional[int] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = Query(20000, le=100000),
):
    s, e = _parse_range(days, start, end)
    rows = await get_board_log_history(board_id, s, e, log_type, limit)
    return {"board_id": board_id, "start": s.isoformat(), "end": e.isoformat(),
            "count": len(rows), "rows": rows}


@router.get("/history/boardlogs.csv")
async def boardlogs_history_csv(
    board_id: str,
    log_type: Optional[str] = None,
    days: Optional[int] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = Query(100000, le=200000),
):
    s, e = _parse_range(days, start, end)
    rows = await get_board_log_history(board_id, s, e, log_type, limit)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "board_id", "type", "index", "label", "value"])
    for r in rows:
        w.writerow([r["timestamp"], r["board_id"], r["type"],
                    r["index"], r["label"], int(r["value"])])

    fname = f"boardlogs_{board_id}_{s.date()}_{e.date()}.csv".replace(":", "-")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── Manual prune (admin) ───────────────────────────────────────────────

@router.post("/history/prune")
async def prune(retain_days: int = 30):
    return await prune_history(max(1, retain_days))
