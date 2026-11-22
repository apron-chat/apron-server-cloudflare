/*
 * Each SQLite table has one owning module (TABLE_OWNERS, src/store/schema.ts):
 * the SQL string literals of src/store name a table only in its owner and
 * in schema.ts's DDL, apart from the exceptions listed here, each with why.
 * And nothing outside src/store touches SQL at all.
 */

import { expect, it } from "vitest";
import { TABLE_OWNERS } from "../../src/store/schema";

const STORE = import.meta.glob("../../src/store/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const SRC = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Where SQL names a table: after FROM, JOIN, INTO, UPDATE, TABLE or ON (an index's table). */
const NAMED = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?: IF NOT EXISTS| IF EXISTS)?|ON)\s+(\w+)/g;

/** Tables a file other than the owner may name: `file: { table: why }`. */
const EXCEPTIONS: Record<string, Record<string, string>> = {
  "sqlite-store.ts": {
    push_subscriptions: "cleanup's expiry, a /purge or /rename moving or deleting a user's rows, and the schema upgrades",
    push_wakes: "cleanup's expiry, /purge, /rename and the schema upgrades",
    read_cursors: "leaving a room deletes its cursor (commit path); /purge, /rename and the schema upgrades",
    room_mutes: "/purge, /rename, cleanup and the schema upgrades",
    user_status: "/purge, /rename, cleanup and the schema upgrades",
    uploads: "a message's uploads go with it (commit path), /purge, /rename, cleanup and the schema upgrades",
  },
  "push.ts": {
    rooms: "a claim reads the room's parent, for room mutes and `joined`",
    user_status: "a claim passes over a muted or `dnd` user",
    room_mutes: "a claim lets only mentions through a room's mute",
    principal_limits: "the day's push counters and `unread` are rows of the limiter table",
  },
  "reads.ts": {
    _meta: "the presence toggle and when it was turned on, read in one statement",
    memberships: "read receipts list a private room's other members",
  },
  "uploads.ts": {
    _meta: "the server's metadata fields, read in one statement",
    identities: "an avatar is kept in its owner's identity row",
    message_state: "a file's write finishes only while its message is retained",
  },
  "admission.ts": {
    principal_limits: "limiterDay reads a limiter row the cache does not hold",
  },
  "room-caps.ts": {
    rooms: "counts the rooms created within the window, by kind",
    memberships: "counts a user's memberships",
  },
  "history-log.ts": {
    records: "history reads the log",
  },
};

it("names each table only in its owning module, schema.ts, and the listed exceptions", () => {
  expect(Object.keys(STORE).some((path) => path.endsWith("/sqlite-store.ts"))).toBe(true);
  const found: string[] = [];
  for (const [path, text] of Object.entries(STORE)) {
    const file = path.split("/").pop()!;
    if (file === "schema.ts") continue;
    for (const match of text.matchAll(NAMED)) {
      const table = match[1];
      const owner = TABLE_OWNERS[table];
      if (!owner || owner === file || EXCEPTIONS[file]?.[table]) continue;
      found.push(`${file} names ${table} (owned by ${owner})`);
    }
  }
  expect([...new Set(found)]).toEqual([]);
});

it("lists only exceptions that are used", () => {
  const unused: string[] = [];
  for (const [file, tables] of Object.entries(EXCEPTIONS)) {
    const text = Object.entries(STORE).find(([path]) => path.endsWith(`/${file}`))?.[1] ?? "";
    const named = new Set([...text.matchAll(NAMED)].map((match) => match[1]));
    for (const table of Object.keys(tables)) if (!named.has(table)) unused.push(`${file}: ${table}`);
  }
  expect(unused).toEqual([]);
});

it("touches SQL only inside src/store", () => {
  expect(Object.keys(SRC).some((path) => path.endsWith("/src/index.ts"))).toBe(true);
  const outside = Object.entries(SRC)
    .filter(([path]) => !path.includes("/src/store/"))
    .filter(([, text]) => /storage\.sql\b|\.sql\.exec\b/.test(text))
    .map(([path]) => path);
  expect(outside).toEqual([]);
});

/**
 * The history chain's state in `_meta` (tier and link values, kept rewrites,
 * the copy marker, the rewrite queue and its sequence) is cached in memory by
 * src/store/history-log.ts, which relies on being its only writer. So no other
 * file may write those keys, apart from the listed sweeps, each of which must
 * make the module forget its cache.
 */
const HISTORY_STATE_WRITERS: Record<string, string> = {
  "sqlite-store.ts": "cleanup's tiers-off sweep deletes the chain's keys, then calls historyLog.forgetState()",
};

it("writes the history chain's cached state only in history-log.ts", () => {
  const writes = /writeMeta\(\s*META_HISTORY_(?:TIER|LINK|KEPT|THROUGH|OPS|OPS_SEQ)\b|["'`]history:(?:tier|link|kept|head|ops)/;
  const sweeps = /_meta\b[^"`]*'history:/;
  const offenders: string[] = [];
  for (const [path, text] of Object.entries(STORE)) {
    const file = path.slice(path.lastIndexOf("/") + 1);
    if (file === "history-log.ts" || file === "meta.ts") continue;
    if (writes.test(text)) offenders.push(`${file}: writes a history state key`);
    if (sweeps.test(text)) {
      if (!HISTORY_STATE_WRITERS[file]) offenders.push(`${file}: sweeps history keys in SQL`);
      else if (!text.includes("historyLog.forgetState()")) offenders.push(`${file}: sweeps history keys without historyLog.forgetState()`);
    }
  }
  expect(offenders).toEqual([]);
  // The listed sweep still exists, so the exception isn't stale.
  const store = Object.entries(STORE).find(([path]) => path.endsWith("/sqlite-store.ts"))?.[1] ?? "";
  expect(sweeps.test(store)).toBe(true);
});
