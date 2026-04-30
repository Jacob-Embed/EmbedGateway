"""End-to-end test: POST -> GET -> soft-DELETE -> verify row still in PG but filtered."""

import json
import urllib.request

import psycopg2

API = "http://127.0.0.1:8000"
BOARD_ID = "USB:CAN2"
DB_URL = "postgresql://postgres:root@localhost:5432/cangateway"


def req(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    r = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=5) as resp:
        return json.loads(resp.read() or b"null")


def pg_row(table: str, row_id: int):
    c = psycopg2.connect(DB_URL)
    cur = c.cursor()
    cur.execute(f'SELECT id, "deletedAt" FROM "{table}" WHERE id = %s', (row_id,))
    row = cur.fetchone()
    c.close()
    return row


def banner(s):
    print(f"\n=== {s} ===")


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


# 1. Create a timer
banner("1. POST /timers -> create")
created = req("POST", "/timers", {
    "board_id": BOARD_ID,
    "name": "e2e-timer",
    "outputs": [{"outputIndex": 3, "onDelaySec": 2, "offDelaySec": 1,
                 "onAuto": True, "offAuto": False}],
    "enabled": True,
})
timer_id = created["timer"]["id"]
print(f"  created timer id={timer_id}")
check("create returns id", isinstance(timer_id, int))
check("create returns name", created["timer"]["name"] == "e2e-timer")

# 2. Read it back
banner("2. GET /timers/{board_id} -> includes new timer")
listed = req("GET", f"/timers/{BOARD_ID}")
names = [t["name"] for t in listed]
check("e2e-timer appears in list", "e2e-timer" in names)

# 3. Verify PG row exists with deletedAt = NULL
banner("3. Postgres row check (deletedAt NULL)")
row = pg_row("TimerPreset", timer_id)
check("row exists in PG", row is not None, detail=str(row))
check("deletedAt is NULL before delete", row and row[1] is None, detail=f"deletedAt={row[1] if row else '?'}")

# 4. Soft delete
banner("4. DELETE /timers/{id} -> soft delete")
req("DELETE", f"/timers/{timer_id}")

# 5. Verify row still exists but deletedAt is set
banner("5. Postgres row still exists, deletedAt is set")
row = pg_row("TimerPreset", timer_id)
check("row NOT hard-deleted", row is not None, detail="row disappeared from PG")
check("deletedAt is NOW set", row and row[1] is not None, detail=f"deletedAt={row[1] if row else '?'}")

# 6. Verify API hides soft-deleted row
banner("6. GET /timers/{board_id} -> soft-deleted row is filtered out")
listed_after = req("GET", f"/timers/{BOARD_ID}")
names_after = [t["name"] for t in listed_after]
check("e2e-timer NOT in list after delete", "e2e-timer" not in names_after,
      detail=f"still present: {names_after}")

# 7. Rule + config for completeness
banner("7. POST /rules with linkedTimerId")
# Create a fresh timer to link to
linked = req("POST", "/timers", {"board_id": BOARD_ID, "name": "e2e-link-tgt",
                                 "outputs": [], "enabled": True})
link_id = linked["timer"]["id"]
rule = req("POST", "/rules", {
    "board_id": BOARD_ID, "name": "e2e-rule", "input_index": 2,
    "trigger": "low", "actions": [{"outputIndex": 0, "value": True}],
    "enabled": True, "linked_timer_id": link_id,
})
rule_id = rule["rule"]["id"]
check("rule created", isinstance(rule_id, int))
check("linkedTimerId persisted", rule["rule"]["linkedTimerId"] == link_id)

banner("8. DELETE linked timer -> rule's linkedTimerId should null out")
req("DELETE", f"/timers/{link_id}")
rules_after = req("GET", f"/rules/{BOARD_ID}")
our_rule = next((r for r in rules_after if r["id"] == rule_id), None)
check("rule still present", our_rule is not None)
check("linkedTimerId nulled after timer soft-delete",
      our_rule and our_rule["linkedTimerId"] is None,
      detail=f"got {our_rule.get('linkedTimerId') if our_rule else '?'}")

banner("9. Cleanup: soft-delete the e2e-rule")
req("DELETE", f"/rules/{rule_id}")
rr = pg_row("InputRule", rule_id)
check("rule row still in PG after soft delete", rr is not None)
check("rule deletedAt is set", rr and rr[1] is not None)

print(f"\n==== RESULT: {passed} passed, {failed} failed ====")
exit(0 if failed == 0 else 1)
