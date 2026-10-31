# /// script
# dependencies = ["websockets>=13"]
# ///
"""Measures one live text on a local `wrangler dev` server (never production).

usage: uv run scripts/live-text-load.py PORT ADMIN_TOKEN SECONDS READERS RATE_BYTES_PER_S admin|user

`user` signs in as a new user from `/invite-token` (120 s), `admin` as the
admin token's user (300 s). The local server needs raised per-address
limits for the readers (docs/cost-report.md, Live text).
Streams colored terminal lines at RATE for SECONDS (the server ends it at its
limit) to a /embed-terminal write URL with READERS readers attached, and
prints wall time, bytes, and the CPU the local workerd and node processes
spent meanwhile (from /proc), less the same span idle measured before."""
import asyncio, json, os, subprocess, sys, time, websockets

PORT, ADMIN, SECONDS, READERS, RATE, WHO = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5]), sys.argv[6]
WS = f"ws://127.0.0.1:{PORT}/ws"
TICK = os.sysconf("SC_CLK_TCK")

def cpu():
    total = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit(): continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().decode(errors="ignore")
            stat = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
        except OSError:
            continue
        kind = "workerd" if "workerd" in cmd else "node" if "wrangler" in cmd or "miniflare" in cmd else None
        if kind: total[kind] = total.get(kind, 0) + (int(stat[11]) + int(stat[12])) / TICK
    return total

async def session(token):
    ws = await websockets.connect(WS, origin=f"http://localhost:{PORT}", max_size=None, ping_interval=None)
    await ws.send(json.dumps({"id": "a", "method": "auth", "params": {"scheme": "token", "token": token}}))
    while True:
        f = json.loads(await ws.recv())
        if f.get("id") == "a": return ws

async def call(ws, id, method, params):
    await ws.send(json.dumps({"id": id, "method": method, "params": params}))
    notices = []
    while True:
        f = json.loads(await ws.recv())
        if f.get("id") == id: return f, notices
        if f.get("method") == "message": notices.append(f)

async def pinger(ws):
    while True:
        await asyncio.sleep(20)
        try: await ws.send('{"method":"ping"}')
        except Exception: return

async def main():
    # Idle baseline over the same span, before anything connects.
    idle0 = cpu(); await asyncio.sleep(min(SECONDS, 60)); idle1 = cpu()
    idle = {k: (idle1[k] - idle0.get(k, 0)) * SECONDS / min(SECONDS, 60) for k in idle1}
    admin = await session(ADMIN)
    asyncio.create_task(pinger(admin))
    token = ADMIN
    if WHO == "user":
        uid = f"measure_{int(time.time())}"
        _, notices = await call(admin, "inv", "command", {"room_id": "general", "body": {"text": f"/invite-token {uid}"}})
        text = notices[-1]["params"]["body"]["text"]
        token = next(w.strip("`") for w in text.split() if w.strip("`").startswith("apron_invite_"))
    writer = await session(token)
    asyncio.create_task(pinger(writer))
    f, _ = await call(writer, "t", "command", {"room_id": "general", "body": {"text": "/embed-terminal measure"}})
    write_url = f["result"]["embeds"][0]["write_url"]
    line = "\x1b[32m[ ok ]\x1b[0m \x1b[1mcompiling\x1b[0m module_{:06d}.c \x1b[33m(warnings: 0)\x1b[0m\r\n"
    per = len(line.format(0).encode())
    interval = per / RATE
    put = subprocess.Popen(["curl", "-sT", "-", write_url], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    c0, t0 = cpu(), time.time()
    put.stdin.write(line.format(0).encode()); put.stdin.flush()
    # The message appears when the PUT arrives: find its url.
    while True:
        m = json.loads(await writer.recv())
        if m.get("method") == "message" and "url" in (m["params"].get("body", {}).get("embeds") or [{}])[0] and m["params"].get("prev_log_id") is None:
            url = m["params"]["body"]["embeds"][0]["url"]; message_id = m["params"]["message_id"]; break
    readers = [subprocess.Popen(["curl", "-s", url], stdout=subprocess.PIPE) for _ in range(READERS)]
    sent, n = per, 1
    try:
        while time.time() - t0 < SECONDS + 5 and put.poll() is None:
            put.stdin.write(line.format(n).encode()); put.stdin.flush(); sent += per; n += 1
            await asyncio.sleep(interval)
    except BrokenPipeError:
        pass
    try: put.stdin.close()
    except BrokenPipeError: pass
    answer = put.stdout.read().decode().strip(); put.wait()
    wall = time.time() - t0
    got = [len(r.communicate()[0]) for r in readers]
    c1 = cpu()
    spent = {k: round(c1[k] - c0.get(k, 0) - idle.get(k, 0), 2) for k in c1}
    finished = None
    while finished is None:
        m = json.loads(await asyncio.wait_for(writer.recv(), 10))
        if m.get("method") == "message" and m["params"].get("message_id") == message_id: finished = m
    output = finished["params"].get("body", {}).get("embeds", [{}])[0].get("output", "")
    print(json.dumps({"who": WHO, "seconds_limit": SECONDS, "readers": READERS, "rate": RATE, "wall_s": round(wall, 1), "sent_bytes": sent,
        "reader_bytes": got, "answer": answer, "output_bytes": len(output.encode()), "cpu_s_less_idle": spent, "idle_cpu_s": {k: round(v, 2) for k, v in idle.items()}}))

asyncio.run(main())
