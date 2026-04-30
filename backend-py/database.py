"""PostgreSQL database access via Prisma. Soft-delete via deletedAt column."""

from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from prisma import Json, Prisma

db = Prisma(auto_register=True)


async def connect_db():
    if not db.is_connected():
        await db.connect()
    print("[database] Prisma connected to PostgreSQL")


async def disconnect_db():
    if db.is_connected():
        await db.disconnect()


async def init_db():
    await connect_db()


def _now():
    return datetime.now(timezone.utc)


async def _ensure_board(board_id: str):
    """Ensure a Board row exists for board_id (ip/port default when unknown)."""
    await db.board.upsert(
        where={"id": board_id},
        data={
            "create": {"id": board_id},
            "update": {},
        },
    )


# ── Board Config ───────────────────────────────────────────────────────

def _board_to_dict(cfg) -> dict:
    return {
        "board_id": cfg.boardId,
        "board_name": cfg.boardName,
        "output_names": list(cfg.outputNames) + [""] * max(0, 15 - len(cfg.outputNames)),
        "input_names": list(cfg.inputNames) + [""] * max(0, 4 - len(cfg.inputNames)),
    }


async def save_board_config(board_id: str, board_name: str = "",
                            output_names: List[str] = None,
                            input_names: List[str] = None) -> dict:
    await _ensure_board(board_id)
    outputs = (output_names or [""] * 15)[:15]
    while len(outputs) < 15:
        outputs.append("")
    inputs = (input_names or [""] * 4)[:4]
    while len(inputs) < 4:
        inputs.append("")

    cfg = await db.boardconfig.upsert(
        where={"boardId": board_id},
        data={
            "create": {
                "board": {"connect": {"id": board_id}},
                "boardName": board_name,
                "outputNames": outputs,
                "inputNames": inputs,
            },
            "update": {
                "boardName": board_name,
                "outputNames": outputs,
                "inputNames": inputs,
                "deletedAt": None,
            },
        },
    )
    return _board_to_dict(cfg)


async def get_board_config(board_id: str) -> Optional[dict]:
    cfg = await db.boardconfig.find_first(
        where={"boardId": board_id, "deletedAt": None},
    )
    return _board_to_dict(cfg) if cfg else None


async def get_all_board_configs() -> Dict[str, dict]:
    rows = await db.boardconfig.find_many(where={"deletedAt": None})
    return {r.boardId: _board_to_dict(r) for r in rows}


# ── Timer Presets ──────────────────────────────────────────────────────

def _timer_to_dict(t) -> dict:
    return {
        "id": t.id,
        "board_id": t.boardId,
        "name": t.name,
        "outputs": t.outputs if isinstance(t.outputs, list) else (t.outputs or []),
        "enabled": bool(t.enabled),
    }


async def save_timer_preset(board_id: str, name: str, outputs: list,
                            enabled: bool = True) -> dict:
    await _ensure_board(board_id)
    timer = await db.timerpreset.create(
        data={
            "board": {"connect": {"id": board_id}},
            "name": name,
            "outputs": Json(outputs or []),
            "enabled": bool(enabled),
        },
    )
    return _timer_to_dict(timer)


async def get_timer_presets(board_id: str) -> List[dict]:
    rows = await db.timerpreset.find_many(
        where={"boardId": board_id, "deletedAt": None},
        order={"id": "asc"},
    )
    return [_timer_to_dict(r) for r in rows]


async def delete_timer_preset(timer_id: int):
    """Soft delete: mark deletedAt. Also null-out linkedTimerId on referring rules."""
    await db.inputrule.update_many(
        where={"linkedTimerId": timer_id},
        data={"linkedTimerId": None},
    )
    await db.timerpreset.update(
        where={"id": timer_id},
        data={"deletedAt": _now()},
    )


async def toggle_timer_preset(timer_id: int):
    current = await db.timerpreset.find_unique(where={"id": timer_id})
    if current is None:
        return
    await db.timerpreset.update(
        where={"id": timer_id},
        data={"enabled": not current.enabled},
    )


# ── Input Rules ────────────────────────────────────────────────────────

def _rule_to_dict(r) -> dict:
    return {
        "id": r.id,
        "board_id": r.boardId,
        "name": r.name,
        "inputIndex": r.inputIndex,
        "trigger": r.trigger,
        "actions": r.actions if isinstance(r.actions, list) else (r.actions or []),
        "enabled": bool(r.enabled),
        "linkedTimerId": r.linkedTimerId,
    }


async def save_input_rule(board_id: str, name: str, input_index: int,
                          trigger_type: str, actions: list,
                          enabled: bool = True,
                          linked_timer_id: int = None) -> dict:
    await _ensure_board(board_id)
    data = {
        "board": {"connect": {"id": board_id}},
        "name": name,
        "inputIndex": int(input_index),
        "trigger": trigger_type,
        "actions": Json(actions or []),
        "enabled": bool(enabled),
    }
    if linked_timer_id is not None:
        data["linkedTimer"] = {"connect": {"id": linked_timer_id}}
    rule = await db.inputrule.create(data=data)
    return _rule_to_dict(rule)


async def get_input_rules(board_id: str) -> List[dict]:
    rows = await db.inputrule.find_many(
        where={"boardId": board_id, "deletedAt": None},
        order={"id": "asc"},
    )
    return [_rule_to_dict(r) for r in rows]


async def delete_input_rule(rule_id: int):
    await db.inputrule.update(
        where={"id": rule_id},
        data={"deletedAt": _now()},
    )


async def toggle_input_rule(rule_id: int):
    current = await db.inputrule.find_unique(where={"id": rule_id})
    if current is None:
        return
    await db.inputrule.update(
        where={"id": rule_id},
        data={"enabled": not current.enabled},
    )


# ── Aggregates ─────────────────────────────────────────────────────────

async def get_full_board_data(board_id: str) -> dict:
    config = await get_board_config(board_id) or {
        "board_id": board_id,
        "board_name": "",
        "output_names": [""] * 15,
        "input_names": [""] * 4,
    }
    config["timerPresets"] = await get_timer_presets(board_id)
    config["inputRules"] = await get_input_rules(board_id)
    return config


async def get_all_full_board_data() -> Dict[str, dict]:
    configs = await get_all_board_configs()
    for board_id in configs:
        configs[board_id]["timerPresets"] = await get_timer_presets(board_id)
        configs[board_id]["inputRules"] = await get_input_rules(board_id)
    return configs


# ── History: CommLog (raw frames) ──────────────────────────────────────

async def save_comm_log(board_id: str, direction: str, raw_frame: str):
    await _ensure_board(board_id)
    await db.commlog.create(
        data={
            "board": {"connect": {"id": board_id}},
            "direction": direction,
            "rawFrame": raw_frame,
        },
    )


async def get_frame_history(board_id: str, start: datetime, end: datetime,
                            direction: Optional[str] = None,
                            limit: int = 10000) -> List[dict]:
    where = {"boardId": board_id, "timestamp": {"gte": start, "lte": end}}
    if direction:
        where["direction"] = direction
    rows = await db.commlog.find_many(
        where=where,
        order={"timestamp": "asc"},
        take=limit,
    )
    return [
        {
            "id": r.id,
            "board_id": r.boardId,
            "direction": r.direction,
            "raw_frame": r.rawFrame,
            "timestamp": r.timestamp.isoformat(),
        }
        for r in rows
    ]


# ── History: SensorReading (parsed byte values) ────────────────────────

async def save_sensor_reading(board_id: str, can_id: str, values: list):
    await _ensure_board(board_id)
    await db.sensorreading.create(
        data={
            "board": {"connect": {"id": board_id}},
            "canId": can_id,
            "values": Json(values),
        },
    )


async def get_sensor_history(board_id: str, start: datetime, end: datetime,
                             can_id: Optional[str] = None,
                             limit: int = 50000) -> List[dict]:
    where = {"boardId": board_id, "timestamp": {"gte": start, "lte": end}}
    if can_id:
        where["canId"] = can_id
    rows = await db.sensorreading.find_many(
        where=where,
        order={"timestamp": "asc"},
        take=limit,
    )
    return [
        {
            "id": r.id,
            "board_id": r.boardId,
            "can_id": r.canId,
            "values": r.values if isinstance(r.values, list) else (r.values or []),
            "timestamp": r.timestamp.isoformat(),
        }
        for r in rows
    ]


# ── History: BoardLog (input/output state changes) ────────────────────

async def save_board_log(board_id: str, log_type: str, index: int,
                         value: bool, label: str = ""):
    await _ensure_board(board_id)
    await db.boardlog.create(
        data={
            "board": {"connect": {"id": board_id}},
            "type": log_type,
            "index": int(index),
            "value": bool(value),
            "label": label or "",
        },
    )


async def get_board_log_history(board_id: str, start: datetime, end: datetime,
                                log_type: Optional[str] = None,
                                limit: int = 20000) -> List[dict]:
    where = {"boardId": board_id, "timestamp": {"gte": start, "lte": end}}
    if log_type:
        where["type"] = log_type
    rows = await db.boardlog.find_many(
        where=where,
        order={"timestamp": "asc"},
        take=limit,
    )
    return [
        {
            "id": r.id,
            "board_id": r.boardId,
            "type": r.type,
            "index": r.index,
            "value": bool(r.value),
            "label": r.label,
            "timestamp": r.timestamp.isoformat(),
        }
        for r in rows
    ]


# ── Retention ──────────────────────────────────────────────────────────

async def prune_history(retain_days: int = 30) -> dict:
    """Hard-delete rows older than retain_days from log/reading tables."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=retain_days)
    comm = await db.commlog.delete_many(where={"timestamp": {"lt": cutoff}})
    sensors = await db.sensorreading.delete_many(where={"timestamp": {"lt": cutoff}})
    board_logs = await db.boardlog.delete_many(where={"timestamp": {"lt": cutoff}})
    print(f"[prune] deleted comm={comm} sensors={sensors} board_logs={board_logs} "
          f"(cutoff={cutoff.isoformat()}, retain_days={retain_days})")
    return {"comm": comm, "sensors": sensors, "board_logs": board_logs}
