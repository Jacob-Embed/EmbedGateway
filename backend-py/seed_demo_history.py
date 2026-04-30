"""Seed a small demo history dataset for USB:CAN2 so the Load button shows a plot.
Produces ~1 sensor reading per 2 minutes over the last 5 days for canId=200."""

import asyncio
import math
import random
from datetime import datetime, timedelta, timezone

from prisma import Json, Prisma

BOARD_ID = "USB:CAN2"
CAN_ID = "200"
DAYS = 5
POINTS_PER_DAY = 24 * 30  # every ~2 min


async def main():
    db = Prisma()
    await db.connect()
    try:
        await db.board.upsert(
            where={"id": BOARD_ID},
            data={"create": {"id": BOARD_ID}, "update": {}},
        )
        total = DAYS * POINTS_PER_DAY
        now = datetime.now(timezone.utc)
        rows = []
        for i in range(total):
            ts = now - timedelta(seconds=(total - i) * (DAYS * 86400 / total))
            t = i / POINTS_PER_DAY  # days elapsed
            # 3 synthetic sensors: slow sine, fast sine + noise, random walk-ish step
            s1 = int(128 + 60 * math.sin(t * 2 * math.pi / 1.0))        # daily cycle
            s2 = int(128 + 40 * math.sin(t * 2 * math.pi / 0.25) + random.randint(-5, 5))
            s3 = int(80 + 20 * ((i // 60) % 4))
            rows.append({
                "board": {"connect": {"id": BOARD_ID}},
                "canId": CAN_ID,
                "values": Json([s1, s2, s3]),
                "timestamp": ts,
            })
        # Batch insert
        for row in rows:
            await db.sensorreading.create(data=row)
        print(f"[seed] inserted {total} SensorReading rows for {BOARD_ID}")
    finally:
        await db.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
