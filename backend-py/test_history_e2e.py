"""End-to-end test for history: seed rows of varying ages, query, CSV, prune."""

import asyncio
import csv
import io
import json
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone

import psycopg2
from prisma import Json, Prisma

API = "http://127.0.0.1:8000"
BOARD_ID = "USB:CAN2"
DB_URL = "postgresql://postgres:root@localhost:5432/cangateway"


def req(path: str, method: str = "GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    r = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=10) as resp:
        return resp.read(), resp.headers


passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


async def seed():
    """Insert synthetic CommLog + SensorReading + BoardLog rows at 5 distinct
    timestamps over the last 5 days, plus one 40-day-old row for prune test."""
    db = Prisma()
    await db.connect()
    try:
        await db.board.upsert(
            where={"id": BOARD_ID},
            data={"create": {"id": BOARD_ID}, "update": {}},
        )
        # Clear any stale test rows for this board so counts are deterministic.
        await db.commlog.delete_many(where={"boardId": BOARD_ID})
        await db.sensorreading.delete_many(where={"boardId": BOARD_ID})
        await db.boardlog.delete_many(where={"boardId": BOARD_ID})

        now = datetime.now(timezone.utc)
        offsets_days = [0, 1, 2, 3, 4, 40]   # 40d row should be pruned at retain=30
        for i, d in enumerate(offsets_days):
            ts = now - timedelta(days=d, minutes=i)
            await db.commlog.create(data={
                "board": {"connect": {"id": BOARD_ID}},
                "direction": "rx",
                "rawFrame": f"200#0B00000000000{i}",
                "timestamp": ts,
            })
            await db.sensorreading.create(data={
                "board": {"connect": {"id": BOARD_ID}},
                "canId": "200",
                "values": Json([11, 0, 0, 0, 0, 0, 0, i]),
                "timestamp": ts,
            })
            # alternate input / output log entries
            await db.boardlog.create(data={
                "board": {"connect": {"id": BOARD_ID}},
                "type": "input" if i % 2 == 0 else "output",
                "index": i % 4,
                "value": bool(i % 2),
                "label": f"{'DI' if i % 2 == 0 else 'DO'}{(i % 4) + 1}",
                "timestamp": ts,
            })
    finally:
        await db.disconnect()


def pg_count(table: str, where_sql: str = ""):
    c = psycopg2.connect(DB_URL)
    cur = c.cursor()
    cur.execute(f'SELECT COUNT(*) FROM "{table}" WHERE "boardId" = %s {where_sql}',
                (BOARD_ID,))
    n = cur.fetchone()[0]
    c.close()
    return n


print("=== seed synthetic history ===")
asyncio.run(seed())
print(f"  seeded: CommLog={pg_count('CommLog')} SensorReading={pg_count('SensorReading')}")

print("\n=== 1. /history/sensors?days=5 returns 5 rows (excludes the 40d one) ===")
body, _ = req(f"/history/sensors?{urllib.parse.urlencode({'board_id': BOARD_ID, 'days': 5})}")
payload = json.loads(body)
check("count is 5", payload["count"] == 5, detail=f"got {payload['count']}")
check("rows ordered ascending",
      all(payload["rows"][i]["timestamp"] <= payload["rows"][i + 1]["timestamp"]
          for i in range(len(payload["rows"]) - 1)))
check("can_id is 200", all(r["can_id"] == "200" for r in payload["rows"]))

print("\n=== 2. /history/sensors?days=1 returns only today's row ===")
body, _ = req(f"/history/sensors?{urllib.parse.urlencode({'board_id': BOARD_ID, 'days': 1})}")
p1 = json.loads(body)
check("days=1 count is 1", p1["count"] == 1, detail=f"got {p1['count']}")

print("\n=== 3. /history/sensors with explicit start/end (last 3 days) ===")
end = datetime.now(timezone.utc)
start = end - timedelta(days=3, hours=1)
body, _ = req(f"/history/sensors?{urllib.parse.urlencode({'board_id': BOARD_ID, 'start': start.isoformat(), 'end': end.isoformat()})}")
p3 = json.loads(body)
check("explicit range count is 4 (days 0,1,2,3)", p3["count"] == 4, detail=f"got {p3['count']}")

print("\n=== 4. /history/sensors.csv returns CSV with correct headers + row count ===")
body, headers = req(f"/history/sensors.csv?{urllib.parse.urlencode({'board_id': BOARD_ID, 'days': 5})}")
text = body.decode()
check("Content-Type is text/csv", "text/csv" in headers.get("content-type", ""))
check("Content-Disposition has filename",
      "attachment" in headers.get("content-disposition", ""))
reader = list(csv.reader(io.StringIO(text)))
check("CSV header starts with timestamp,board_id,can_id",
      reader[0][:3] == ["timestamp", "board_id", "can_id"],
      detail=str(reader[0][:3]))
check("CSV has 5 data rows", len(reader) == 6, detail=f"rows={len(reader)}")

print("\n=== 5. /history/frames?days=5 returns 5 frame rows ===")
body, _ = req(f"/history/frames?{urllib.parse.urlencode({'board_id': BOARD_ID, 'days': 5})}")
p5 = json.loads(body)
check("frame count is 5", p5["count"] == 5, detail=f"got {p5['count']}")
check("directions all 'rx'", all(r["direction"] == "rx" for r in p5["rows"]))

print("\n=== 6. /history/frames.csv ===")
body, _ = req(f"/history/frames.csv?{urllib.parse.urlencode({'board_id': BOARD_ID, 'days': 5})}")
reader = list(csv.reader(io.StringIO(body.decode())))
check("frames CSV header",
      reader[0] == ["timestamp", "board_id", "direction", "raw_frame"])
check("frames CSV has 5 rows", len(reader) == 6)

print("\n=== 6b. /history/boardlogs?days=5 returns 5 state-change rows ===")
body, _ = req(f"/history/boardlogs?{urllib.parse.urlencode({'board_id': BOARD_ID, 'days': 5})}")
p6b = json.loads(body)
check("boardlogs count is 5", p6b["count"] == 5, detail=f"got {p6b['count']}")
check("boardlogs has both input and output types",
      {r["type"] for r in p6b["rows"]} == {"input", "output"},
      detail=str({r["type"] for r in p6b["rows"]}))

print("\n=== 6c. /history/boardlogs?log_type=output filters correctly ===")
body, _ = req(f"/history/boardlogs?{urllib.parse.urlencode({'board_id': BOARD_ID, 'days': 5, 'log_type': 'output'})}")
p6c = json.loads(body)
check("output-only filter", all(r["type"] == "output" for r in p6c["rows"]))

print("\n=== 6d. /history/boardlogs.csv ===")
body, _ = req(f"/history/boardlogs.csv?{urllib.parse.urlencode({'board_id': BOARD_ID, 'days': 5})}")
reader = list(csv.reader(io.StringIO(body.decode())))
check("boardlogs CSV header",
      reader[0] == ["timestamp", "board_id", "type", "index", "label", "value"])
check("boardlogs CSV has 5 rows", len(reader) == 6)

print("\n=== 7. /history/prune with retain_days=30 removes the 40d row ===")
before_cl = pg_count("CommLog")
before_sr = pg_count("SensorReading")
before_bl = pg_count("BoardLog")
body, _ = req("/history/prune?retain_days=30", method="POST")
res = json.loads(body)
after_cl = pg_count("CommLog")
after_sr = pg_count("SensorReading")
after_bl = pg_count("BoardLog")
check("CommLog pruned by at least 1", before_cl - after_cl >= 1,
      detail=f"before={before_cl} after={after_cl}")
check("SensorReading pruned by at least 1", before_sr - after_sr >= 1,
      detail=f"before={before_sr} after={after_sr}")
check("BoardLog pruned by at least 1", before_bl - after_bl >= 1,
      detail=f"before={before_bl} after={after_bl}")
check("prune response reports all three",
      res.get("comm", 0) >= 1 and res.get("sensors", 0) >= 1
      and res.get("board_logs", 0) >= 1)

print("\n=== 8. Cleanup seeded rows ===")


async def cleanup():
    db = Prisma()
    await db.connect()
    try:
        await db.commlog.delete_many(where={"boardId": BOARD_ID})
        await db.sensorreading.delete_many(where={"boardId": BOARD_ID})
        await db.boardlog.delete_many(where={"boardId": BOARD_ID})
    finally:
        await db.disconnect()


asyncio.run(cleanup())
print("  cleaned.")

print(f"\n==== RESULT: {passed} passed, {failed} failed ====")
exit(0 if failed == 0 else 1)
