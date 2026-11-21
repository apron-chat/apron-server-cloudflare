/*
 * Opening the store: a SqliteStore over the Durable Object's SQLite, and
 * the parts (parts.ts) over it.
 */

import type { StoreConfig } from "./config";
import type { Store } from "./parts";
import {
  sqliteAccounts, sqliteAdmission, sqliteCredentials, sqliteHistory, sqliteLifecycle, sqliteLiveText, sqliteMessages, sqliteMeter, sqliteOps,
  sqlitePush, sqliteReads, sqliteRooms, sqliteServer, sqliteUploads,
} from "./sqlite-parts";
import { SqliteStore } from "./sqlite-store";
import type { StoreClock } from "./types";

/** The SqliteStore under each Store openStore made, for tests that reach into it (sqliteOf). */
const UNDER = new WeakMap<Store, SqliteStore>();

/**
 * The store over a Durable Object's storage (its state, its storage, or
 * a SQL handle), with `config` over the defaults (defaultStoreConfig).
 * Call `lifecycle.initialize()` before anything else.
 */
export function openStore(storage: unknown, config: Partial<StoreConfig> = {}, clock?: StoreClock | (() => number)): Store {
  return storeOver(new SqliteStore(storage, config, clock));
}

/** The parts over an existing SqliteStore. */
export function storeOver(sqlite: SqliteStore): Store {
  const store: Store = Object.freeze({
    accounts: sqliteAccounts(sqlite),
    credentials: sqliteCredentials(sqlite),
    rooms: sqliteRooms(sqlite),
    messages: sqliteMessages(sqlite),
    reads: sqliteReads(sqlite),
    server: sqliteServer(sqlite),
    admission: sqliteAdmission(sqlite),
    meter: sqliteMeter(sqlite),
    ops: sqliteOps(sqlite),
    lifecycle: sqliteLifecycle(sqlite),
    history: sqliteHistory(sqlite),
    // The optional parts, decided once from the configuration that gates the
    // features (asStoreConfig). A runtime toggle (`/toggle uploads`) leaves
    // them be; the store's own cleanup prunes their tables either way.
    ...(sqlite.config.push ? { push: sqlitePush(sqlite) } : {}),
    ...(sqlite.config.uploads ? { uploads: sqliteUploads(sqlite) } : {}),
    ...(sqlite.config.liveText ? { liveText: sqliteLiveText(sqlite) } : {}),
  });
  UNDER.set(store, sqlite);
  return store;
}

/** The SqliteStore a Store from openStore or storeOver runs over: for tests of its internals. */
export function sqliteOf(store: Store): SqliteStore {
  const sqlite = UNDER.get(store);
  if (!sqlite) throw new Error("not a store openStore made");
  return sqlite;
}
