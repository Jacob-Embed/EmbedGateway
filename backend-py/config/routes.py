"""Board configuration — names, labels, timers, rules — persisted to SQLite."""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Optional

from database import (
    save_board_config, get_board_config,
    save_timer_preset, get_timer_presets, delete_timer_preset, toggle_timer_preset,
    save_input_rule, get_input_rules, delete_input_rule, toggle_input_rule,
    get_full_board_data, get_all_full_board_data,
)

router = APIRouter(tags=["config"])


# ── Models ─────────────────────────────────────────────────────────────

class BoardConfigUpdate(BaseModel):
    board_id: str
    board_name: Optional[str] = None
    output_names: Optional[List[str]] = None
    input_names: Optional[List[str]] = None


class TimerPresetCreate(BaseModel):
    board_id: str
    name: str = ""
    outputs: list = []
    enabled: bool = True


class InputRuleCreate(BaseModel):
    board_id: str
    name: str = ""
    input_index: int = 0
    trigger: str = "high"
    actions: list = []
    enabled: bool = True
    linked_timer_id: Optional[int] = None


class LinkedAutomationCreate(BaseModel):
    """Create a timer + rule together (the 'Both' option)."""
    board_id: str
    name: str = ""
    timer_outputs: list = []
    input_index: int = 0
    trigger: str = "high"
    rule_actions: list = []


# ── Board Config endpoints ─────────────────────────────────────────────

@router.get("/config")
async def get_all_configs():
    return await get_all_full_board_data()


@router.get("/config/{board_id}")
async def get_config(board_id: str):
    return await get_full_board_data(board_id)


@router.post("/config")
async def update_config(cfg: BoardConfigUpdate):
    existing = await get_board_config(cfg.board_id) or {
        "board_name": "", "output_names": [""] * 15, "input_names": [""] * 4,
    }
    board_name = cfg.board_name if cfg.board_name is not None else existing.get("board_name", "")
    output_names = cfg.output_names[:15] if cfg.output_names is not None else existing.get("output_names", [""] * 15)
    input_names = cfg.input_names[:4] if cfg.input_names is not None else existing.get("input_names", [""] * 4)
    result = await save_board_config(cfg.board_id, board_name, output_names, input_names)
    return {"status": "ok", "config": result}


# ── Timer Preset endpoints ─────────────────────────────────────────────

@router.get("/timers/{board_id}")
async def get_timers(board_id: str):
    return await get_timer_presets(board_id)


@router.post("/timers")
async def create_timer(data: TimerPresetCreate):
    result = await save_timer_preset(data.board_id, data.name, data.outputs, data.enabled)
    return {"status": "ok", "timer": result}


@router.delete("/timers/{timer_id}")
async def remove_timer(timer_id: int):
    await delete_timer_preset(timer_id)
    return {"status": "deleted"}


@router.patch("/timers/{timer_id}/toggle")
async def toggle_timer(timer_id: int):
    await toggle_timer_preset(timer_id)
    return {"status": "toggled"}


# ── Input Rule endpoints ───────────────────────────────────────────────

@router.get("/rules/{board_id}")
async def get_rules(board_id: str):
    return await get_input_rules(board_id)


@router.post("/rules")
async def create_rule(data: InputRuleCreate):
    result = await save_input_rule(
        data.board_id, data.name, data.input_index, data.trigger,
        data.actions, data.enabled, data.linked_timer_id,
    )
    return {"status": "ok", "rule": result}


@router.delete("/rules/{rule_id}")
async def remove_rule(rule_id: int):
    await delete_input_rule(rule_id)
    return {"status": "deleted"}


@router.patch("/rules/{rule_id}/toggle")
async def toggle_rule(rule_id: int):
    await toggle_input_rule(rule_id)
    return {"status": "toggled"}


# ── Linked Automation (Both) ──────────────────────────────────────────

@router.post("/automation/linked")
async def create_linked_automation(data: LinkedAutomationCreate):
    """Create a timer + rule linked together (the 'Both' option)."""
    timer = await save_timer_preset(data.board_id, data.name, data.timer_outputs, True)
    rule = await save_input_rule(
        data.board_id,
        data.name or f"Rule for {timer['name']}",
        data.input_index, data.trigger,
        data.rule_actions, True,
        timer["id"],
    )
    return {"status": "ok", "timer": timer, "rule": rule}
