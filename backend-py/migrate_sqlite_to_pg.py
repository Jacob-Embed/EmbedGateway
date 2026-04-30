"""One-shot migration: copy rows from cangateway.db (SQLite) into Postgres via Prisma."""

import asyncio
import json
import os
import sqlite3

from prisma import Json, Prisma

SQLITE_PATH = os.path.join(os.path.dirname(__file__), "cangateway.db")


async def main():
    if not os.path.exists(SQLITE_PATH):
        print(f"[migrate] no SQLite file at {SQLITE_PATH} — nothing to migrate")
        return

    src = sqlite3.connect(SQLITE_PATH)
    src.row_factory = sqlite3.Row

    db = Prisma()
    await db.connect()

    try:
        boards_seen: set[str] = set()
        boards = src.execute("SELECT * FROM board_configs").fetchall()
        configs_inserted = 0
        for row in boards:
            board_id = row["board_id"]
            boards_seen.add(board_id)

            await db.board.upsert(
                where={"id": board_id},
                data={"create": {"id": board_id}, "update": {}},
            )

            output_names = json.loads(row["output_names"] or "[]")
            input_names = json.loads(row["input_names"] or "[]")
            await db.boardconfig.upsert(
                where={"boardId": board_id},
                data={
                    "create": {
                        "board": {"connect": {"id": board_id}},
                        "boardName": row["board_name"] or "",
                        "outputNames": output_names,
                        "inputNames": input_names,
                    },
                    "update": {
                        "boardName": row["board_name"] or "",
                        "outputNames": output_names,
                        "inputNames": input_names,
                    },
                },
            )
            configs_inserted += 1

        timers = src.execute("SELECT * FROM timer_presets").fetchall()
        old_to_new_timer_id: dict[int, int] = {}
        for row in timers:
            if row["board_id"] not in boards_seen:
                await db.board.upsert(
                    where={"id": row["board_id"]},
                    data={"create": {"id": row["board_id"]}, "update": {}},
                )
                boards_seen.add(row["board_id"])
            created = await db.timerpreset.create(
                data={
                    "board": {"connect": {"id": row["board_id"]}},
                    "name": row["name"] or "",
                    "outputs": Json(json.loads(row["outputs"] or "[]")),
                    "enabled": bool(row["enabled"]),
                },
            )
            old_to_new_timer_id[row["id"]] = created.id

        rules = src.execute("SELECT * FROM input_rules").fetchall()
        for row in rules:
            if row["board_id"] not in boards_seen:
                await db.board.upsert(
                    where={"id": row["board_id"]},
                    data={"create": {"id": row["board_id"]}, "update": {}},
                )
                boards_seen.add(row["board_id"])
            linked_old = row["linked_timer_id"]
            linked_new = old_to_new_timer_id.get(linked_old) if linked_old is not None else None
            data = {
                "board": {"connect": {"id": row["board_id"]}},
                "name": row["name"] or "",
                "inputIndex": int(row["input_index"] or 0),
                "trigger": row["trigger_type"] or "high",
                "actions": Json(json.loads(row["actions"] or "[]")),
                "enabled": bool(row["enabled"]),
            }
            if linked_new is not None:
                data["linkedTimer"] = {"connect": {"id": linked_new}}
            await db.inputrule.create(data=data)

        print(
            f"[migrate] boards={len(boards_seen)} "
            f"configs={configs_inserted} "
            f"timers={len(timers)} "
            f"rules={len(rules)}"
        )
    finally:
        src.close()
        await db.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
