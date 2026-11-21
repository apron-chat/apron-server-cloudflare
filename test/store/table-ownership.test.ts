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
