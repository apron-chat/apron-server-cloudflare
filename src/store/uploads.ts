/*
 * Uploads held in R2 (`uploads` rows): starting them, their writes'
 * completion and expiry, the stored-bytes count, avatars, and what the
 * server keeps in uploads and `_meta` beside them: its metadata (`/server`),
 * its custom emoji catalog (`/emoji`), and the admins' feature toggles
 * (`/toggle`). One module, as emoji and the server's avatar are uploads. The
 * Uploads and Server parts delegate here; the commit path starts and
 * releases a message's uploads through it.
 */

import { StoreError, limitData } from "../store-error";
import { UPLOAD_SWEEP_BATCH, UPLOAD_WRITES, UPLOAD_WRITE_GRACE_MS } from "./limits";
import { EMOJI_OWNER, META_EMOJI_CATALOG, META_EMOJI_PREVIOUS, META_PRESENCE_ON, META_SERVER_PREFIX, META_TOGGLE_PREFIX, META_UPLOAD_BYTES, SERVER_FIELDS, SERVER_OWNER } from "./meta";
import { type RawUploadRow, dayCount, dayFor, emojiObjectKey, integerColumn, isPlainObject, parseJson, randomKey } from "./rows";
import type { Broadcast, EmojiDraft, EmojiEdit, EmojiEntry, PendingUpload, StoredServerMetadata, UploadFinish, UploadPurpose, UploadWrite } from "./types";
import type { Sql, StoreCore } from "./core";

/** Uploads and the server's settings over the store's core: the Uploads part's implementation, and the Server part's. */
export class UploadsModule {
  constructor(private readonly core: StoreCore) {}

  /**
   * The custom emoji catalog (META_EMOJI_CATALOG), read on first need after
   * a wake (one row) and replaced on every edit, so a reaction's key is
   * checked against it with no read.
   */
  emojiCache: { key: string | null; json: string; entries: Record<string, EmojiEntry>; keys: ReadonlySet<string> } | null = null;

  /** The server's stored `title`, `description` and `avatar` (`/server`), read once and kept with every change. */
  serverCache: StoredServerMetadata | null = null;

  /**
   * The most upload rows `owner` can hold: a day's uploads for every day the
   * longest-kept kind stays, with the lifecycle's lag, and one more day. A
   * user's day is `uploadsPerUserDay`, and their live texts' starts, each of
   * which may keep a terminal's output. The server's own avatar uploads
   * (SERVER_OWNER) are charged to the admins who start them, so only the
   * server-wide `uploadsPerDay` bounds them. A scan of an owner's rows by
   * `uploads_owner_idx` reads up to this many, whatever its other conditions
   * and LIMIT, since the index holds only `owner_id`.
   */
  uploadsPerOwner(owner: string): number {
    const policy = this.core.config.uploads;
    if (!policy) return 0;
    // A user's finished terminals may each keep their output as a file too (storeTerminalOutput).
    const perDay = owner === SERVER_OWNER ? policy.uploadsPerDay : policy.uploadsPerUserDay + (this.core.config.liveText?.startsPerUserDay ?? 0);
    const keptSeconds = Math.max(policy.fileRetentionSeconds, policy.avatarRetentionSeconds) + policy.lifecycleLagSeconds;
    return perDay * (Math.ceil(keptSeconds / 86_400) + 1);
  }

  /**
   * Starts an upload (protocol §4.8.3) for a registered user: charges the
   * user's daily upload count, and reserves the largest size against the
   * stored-bytes cap until the write reports its size. The server's daily
   * count is only checked here: it is charged when a write is claimed
   * (claimUpload), so uploads started and never written cannot close
   * uploads for everyone.
   */
  startUpload(sql: Sql, purpose: UploadPurpose, userId: string, now: number, link: { messageId?: string; embedId: string }, owner = userId): PendingUpload {
    const policy = this.core.config.uploads;
    if (!policy) throw new StoreError("unsupported", "Uploads are not available here");
    if (!sql.identityRow(userId)) throw new StoreError("denied", "Sign in with a passkey to upload");
    if (sql.metaValue(META_TOGGLE_PREFIX + "uploads") === "off") throw new StoreError("denied", "Uploads are turned off here");
    this.core.assertNotDegraded("Uploading", now);
    // The server's avatar is an avatar in size.
    const maxBytes = purpose === "file" ? policy.maxFileBytes : purpose === "emoji" ? policy.maxEmojiBytes : policy.maxAvatarBytes;
    const day = dayFor(now);
    const rows = [sql.limitRow("upload", `user:${userId}`, now), sql.limitRow("upload", "global", now)];
    const counts = rows.map((row) => dayCount(row, "uploads_day", day));
    const untilReset = Math.max(1, 86_400_000 - now % 86_400_000);
    if (counts[1] >= policy.uploadsPerDay) throw new StoreError("retry_after", "Daily upload limit reached for the server", { retryAfterMs: untilReset, data: limitData("upload") });
    if (counts[0] >= policy.uploadsPerUserDay) throw new StoreError("retry_after", "Daily upload limit reached", { retryAfterMs: untilReset, data: limitData("upload") });
    const stored = sql.metaNumber(META_UPLOAD_BYTES);
    if (stored + maxBytes > policy.storedBytesCap) {
      throw new StoreError("retry_after", "Upload storage is full", { retryAfterMs: 3_600_000, data: limitData("upload") });
    }
    sql.updateLimitRow(rows[0], { day, uploads_day: counts[0] + 1 }, now);
    this.setUploadBytes(sql, stored + maxBytes);
    // The server's avatar is kept like a custom emoji, under `e/`, which the
    // bucket's lifecycle rules leave alone.
    const kept = purpose === "emoji" || purpose === "server";
    const key = `${purpose === "file" ? "f" : kept ? "e" : "a"}/${randomKey()}`;
    const writeExpiresMs = now + policy.writeWindowSeconds * 1_000;
    // Custom emoji and the server's avatar never expire: they go when an
    // admin removes or replaces them.
    const expiresMs = kept ? Number.MAX_SAFE_INTEGER : now + (purpose === "file" ? policy.fileRetentionSeconds : policy.avatarRetentionSeconds) * 1_000;
    sql.exec(
      `INSERT INTO uploads (upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms, created_ms)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      key, owner, purpose, link.messageId ?? null, link.embedId, maxBytes, writeExpiresMs, expiresMs, now,
    );
    return { key, purpose, embedId: link.embedId, maxBytes, writeExpiresMs };
  }

  setUploadBytes(sql: Sql, bytes: number): void {
    sql.writeMeta(META_UPLOAD_BYTES, String(Math.max(0, bytes)));
  }

  uploadRow(sql: Sql, key: string): RawUploadRow | null {
    return sql.rows<RawUploadRow>(
      `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
       FROM uploads WHERE upload_key = ? LIMIT 1`,
      key,
    )[0] ?? null;
  }

  /** A message's uploads, all of them or those of some embeds. Bounded by the embeds a message may carry. */
  messageUploads(sql: Sql, messageId: string, embedIds?: readonly string[]): RawUploadRow[] {
    if (embedIds && !embedIds.length) return [];
    const rows = sql.rows<RawUploadRow>(
      `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
       FROM uploads INDEXED BY uploads_message_idx WHERE message_id = ? LIMIT ?`,
      messageId, 4 * this.core.config.maxEmbeds,
    );
    return embedIds ? rows.filter((row) => row.embed_id !== null && embedIds.includes(row.embed_id)) : rows;
  }

  /** Forgets uploads and frees their bytes; returns their keys, whose R2 objects the caller deletes. */
  releaseUploadRows(sql: Sql, rows: readonly RawUploadRow[]): string[] {
    if (!rows.length) return [];
    let freed = 0;
    for (const row of rows) {
      sql.exec("DELETE FROM uploads WHERE upload_key = ?", row.upload_key);
      freed += row.bytes;
    }
    this.setUploadBytes(sql, sql.metaNumber(META_UPLOAD_BYTES) - freed);
    return rows.map((row) => row.upload_key);
  }

  /** Marks a pending upload written, counting its real size in place of the largest. */
  private completeUploadRow(sql: Sql, row: RawUploadRow, bytes: number): void {
    sql.exec("UPDATE uploads SET state = 'done', bytes = ? WHERE upload_key = ?", bytes, row.upload_key);
    this.setUploadBytes(sql, sql.metaNumber(META_UPLOAD_BYTES) - row.bytes + bytes);
  }

  /** An admin's `/toggle` of a feature, or undefined while it follows the deployment's default. */
  toggle(feature: string, now = this.core.clock.now()): boolean | undefined {
    this.core.ensureReady();
    return this.core.reserved("toggle", { reads: 4 }, false, now, (sql) => {
      const value = sql.metaValue(META_TOGGLE_PREFIX + feature);
      return value === "on" ? true : value === "off" ? false : undefined;
    });
  }

  /**
   * Sets or, with undefined, clears an admin's `/toggle` of a feature. With
   * `uploads` off, new upload embeds and `/avatar` are `denied`; writes
   * already started still finish. With `since`, presence was turned on
   * then: it is kept too (META_PRESENCE_ON), in the same reservation.
   */
  setToggle(feature: string, on: boolean | undefined, now = this.core.clock.now(), since?: number): void {
    this.core.ensureReady();
    this.core.reserved("setToggle", { reads: 4, writes: 8 }, false, now, (sql) => sql.transaction(() => {
      sql.writeMeta(META_TOGGLE_PREFIX + feature, on === undefined ? null : on ? "on" : "off");
      if (since !== undefined) sql.writeMeta(META_PRESENCE_ON, String(since));
    }));
  }

  /**
   * Starts an avatar upload (protocol §4.8.7): `/avatar` with one `upload`
   * embed. The avatar is set when the write finishes (finishUpload).
   */
  startAvatarUpload(input: { userId: string; now?: number }): PendingUpload {
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    return this.core.reserved("startAvatarUpload", { reads: 32, writes: UPLOAD_WRITES + 8 }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      return this.startUpload(sql, "avatar", input.userId, effective, { embedId: `embed_${randomKey()}` });
    }));
  }

  /**
   * Starts a custom emoji upload (extension `ext:emoji`): `/emoji add
   * :name:` with one `upload` embed, by a holder of one of EMOJI_ROLES. The
   * upload row keeps the key in `message_id`, and is the server's
   * (EMOJI_OWNER); it counts
   * against the user's and the server's daily uploads and the stored-bytes
   * cap like any other. The catalog changes when the write finishes
   * (emojiDraft, commitEmoji). A new key past `maxEmoji` is `denied`.
   */
  startEmojiUpload(input: { userId: string; key: string; now?: number }): PendingUpload {
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    return this.core.reserved("startEmojiUpload", { reads: 32, writes: UPLOAD_WRITES + 8 }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const catalog = this.loadEmojiCatalog(sql);
      const most = this.core.config.uploads?.maxEmoji ?? 0;
      if (!catalog.keys.has(input.key) && catalog.keys.size >= most) throw new StoreError("denied", `This server keeps at most ${most} custom emoji; remove one first`);
      return this.startUpload(sql, "emoji", input.userId, effective, { messageId: input.key, embedId: `embed_${randomKey()}` }, EMOJI_OWNER);
    }));
  }

  /**
   * Starts the server's avatar upload (§3.1, §4.8.7): `/server avatar` with
   * one `upload` embed, by an admin. Kept like a custom emoji: the server's
   * (SERVER_OWNER), never expiring, an avatar in size, and counted against
   * the admin's and the server's daily uploads and the stored-bytes cap.
   * The avatar is set when the write finishes (finishUpload).
   */
  startServerAvatarUpload(input: { userId: string; now?: number }): PendingUpload {
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    return this.core.reserved("startServerAvatarUpload", { reads: 32, writes: UPLOAD_WRITES + 8 }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      return this.startUpload(sql, "server", input.userId, effective, { embedId: `embed_${randomKey()}` }, SERVER_OWNER);
    }));
  }

  /**
   * The server's `title`, `description` and `avatar` as admins set them with
   * `/server`, each absent while its deployment variable applies. Read once
   * after a wake (three primary-key lookups of `_meta`), then kept in memory.
   */
  serverMetadata(now = this.core.clock.now()): StoredServerMetadata {
    this.core.ensureReady();
    return { ...(this.serverCache ?? this.core.reserved("serverMetadata", { reads: 4 }, false, now, (sql) => this.loadServerMetadata(sql))) };
  }

  /** The cached server metadata, read from its `_meta` rows on first need; the caller holds a reservation. */
  private loadServerMetadata(sql: Sql): StoredServerMetadata {
    if (this.serverCache) return this.serverCache;
    const rows = sql.rows<{ key: string; value: string }>(
      "SELECT key, value FROM _meta WHERE key IN (?, ?, ?)",
      ...SERVER_FIELDS.map((field) => META_SERVER_PREFIX + field),
    );
    const stored: StoredServerMetadata = {};
    for (const field of SERVER_FIELDS) {
      const value = rows.find((row) => row.key === META_SERVER_PREFIX + field)?.value;
      if (value) stored[field] = value;
    }
    this.serverCache = stored;
    return stored;
  }

  /** Keeps one stored server field, or with undefined forgets it; the caller holds a reservation. */
  private writeServerField(sql: Sql, field: (typeof SERVER_FIELDS)[number], value: string | undefined): void {
    const stored = { ...this.loadServerMetadata(sql) };
    if (value === undefined) {
      sql.writeMeta(META_SERVER_PREFIX + field, null);
      delete stored[field];
    } else {
      sql.writeMeta(META_SERVER_PREFIX + field, value);
      stored[field] = value;
    }
    this.serverCache = stored;
  }

  /**
   * Sets the server's `title` or `description` (`/server title <text>`,
   * `/server description <text>`), or with undefined clears it, so its
   * deployment variable applies again. The caller validates the value.
   */
  setServerText(field: "title" | "description", value: string | undefined, now = this.core.clock.now()): void {
    this.core.ensureReady();
    this.core.reserved("setServerText", { reads: 8, writes: 8 }, false, now, (sql) => sql.transaction(() => this.writeServerField(sql, field, value)));
  }

  /**
   * Clears the server's avatar (`/server avatar` alone), so `SERVER_AVATAR`
   * applies again: forgets its URL and releases its upload, whose R2 object
   * the caller deletes. Returns whether one was set.
   */
  clearServerAvatar(now = this.core.clock.now()): { changed: boolean; deletedUploads: string[] } {
    this.core.ensureReady();
    // Its upload is found by a scan of every upload the server owns (uploadsPerOwner).
    return this.core.reserved("clearServerAvatar", { reads: 32 + this.uploadsPerOwner(SERVER_OWNER), writes: 32 }, false, now, (sql) => sql.transaction(() => {
      const changed = this.loadServerMetadata(sql).avatar !== undefined;
      if (changed) this.writeServerField(sql, "avatar", undefined);
      const rows = sql.rows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id = ? AND purpose = 'server' AND state = 'done' LIMIT 8`,
        SERVER_OWNER,
      );
      return { changed, deletedUploads: this.releaseUploadRows(sql, rows) };
    }));
  }

  /**
   * The custom emoji catalog (extension `ext:emoji`): its `catalog_url` on
   * the media origin and its keys, or null while it is empty or uploads are
   * not configured. Read once after a wake (one row), then kept in memory.
   */
  emojiCatalog(now = this.core.clock.now()): { url: string; keys: ReadonlySet<string> } | null {
    this.core.ensureReady();
    const origin = this.core.config.uploads?.mediaOrigin;
    if (!origin) return null;
    const catalog = this.emojiCache ?? this.core.reserved("emojiCatalog", { reads: 4 }, false, now, (sql) => this.loadEmojiCatalog(sql));
    return catalog.key ? { url: `${origin}/${catalog.key}`, keys: catalog.keys } : null;
  }

  /** The cached catalog, read from META_EMOJI_CATALOG on first need; the caller holds a reservation. */
  loadEmojiCatalog(sql: Sql): NonNullable<UploadsModule["emojiCache"]> {
    if (this.emojiCache) return this.emojiCache;
    const json = sql.metaValue(META_EMOJI_CATALOG);
    const parsed = json ? parseJson<unknown>(json, null) : null;
    const entries = isPlainObject(parsed) ? parsed as Record<string, EmojiEntry> : {};
    this.emojiCache = this.emojiCacheFor(Object.keys(entries).length ? json : "", entries);
    return this.emojiCache;
  }

  private emojiCacheFor(json: string, entries: Record<string, EmojiEntry>): NonNullable<UploadsModule["emojiCache"]> {
    return { key: json ? emojiObjectKey(json) : null, json, entries, keys: new Set(Object.keys(entries)) };
  }

  /**
   * The catalog an edit leads to, changing nothing, so the caller can
   * publish it to R2 before commitEmoji makes it current: with an added
   * key's entry (its image's `url`, and `width` and `height` where the
   * write found them), or without a removed one. Null when the edit cannot
   * apply: a write that is not an emoji's, failed, came too late or is not
   * an image, or a new key past `maxEmoji` (finishUpload then releases
   * it), or a removed key the catalog lacks.
   */
  emojiDraft(edit: EmojiEdit, now = this.core.clock.now()): EmojiDraft | null {
    this.core.ensureReady();
    const origin = this.core.config.uploads?.mediaOrigin;
    if (!origin) return null;
    return this.core.reserved("emojiDraft", { reads: 16 }, false, now, (sql) => {
      const catalog = this.loadEmojiCatalog(sql);
      let entries: Record<string, EmojiEntry>;
      if ("add" in edit) {
        const write = edit.add;
        const row = this.uploadRow(sql, write.key);
        if (!row || row.purpose !== "emoji" || !row.message_id || !this.emojiWriteAccepted(row, write, this.core.effectiveNow(now))) return null;
        if (!catalog.keys.has(row.message_id) && catalog.keys.size >= (this.core.config.uploads?.maxEmoji ?? 0)) return null;
        const entry: EmojiEntry = { url: `${origin}/${row.upload_key}`, ...(write.width && write.height ? { width: write.width, height: write.height } : {}) };
        entries = { ...catalog.entries, [row.message_id]: entry };
      } else {
        if (!catalog.keys.has(edit.remove)) return null;
        entries = Object.fromEntries(Object.entries(catalog.entries).filter(([key]) => key !== edit.remove));
      }
      const json = Object.keys(entries).length ? JSON.stringify(entries) : "";
      return { edit, json, key: json ? emojiObjectKey(json) : null, entries };
    });
  }

  /** Whether a finished write may become a custom emoji: still writing, in time, an image within its size. */
  private emojiWriteAccepted(row: RawUploadRow, write: UploadWrite, now: number): boolean {
    return row.state === "writing" && now <= row.write_expires_ms + UPLOAD_WRITE_GRACE_MS &&
      write.ok && typeof write.bytes === "number" && write.bytes > 0 && write.bytes <= row.bytes && !!write.contentType?.startsWith("image/");
  }

  /**
   * Makes a draft's catalog current, in one transaction with the edit: an
   * added key's upload is done. The catalog before this one becomes the
   * previous (META_EMOJI_PREVIOUS), and the image an add replaces or a
   * remove removes is `superseded`: both stay for clients that just read
   * the previous `catalog_url`. The catalog before that, and the images
   * superseded with it, are released. Returns whether it applied (a draft
   * whose catalog changed meanwhile, or whose write is no longer
   * acceptable, does not), and the R2 objects the caller deletes.
   */
  commitEmoji(draft: EmojiDraft, now = this.core.clock.now()): { applied: boolean; deletedUploads: string[] } {
    this.core.ensureReady();
    const most = this.core.config.uploads?.maxEmoji ?? 0;
    const result = this.core.reserved("commitEmoji", { reads: 96, writes: 96 + UPLOAD_WRITES }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const before = this.loadEmojiCatalog(sql);
      // Everything is checked before anything is written.
      const write = "add" in draft.edit ? draft.edit.add : null;
      const row = write ? this.uploadRow(sql, write.key) : null;
      const name = row ? row.message_id : "remove" in draft.edit ? draft.edit.remove : null;
      if (!name || (write && (!row || row.purpose !== "emoji" || !this.emojiWriteAccepted(row, write, effective)))) return null;
      if (row && draft.entries[name]?.url !== `${this.core.config.uploads?.mediaOrigin}/${row.upload_key}`) return null;
      if (row && !before.keys.has(name) && before.keys.size >= most) return null;
      // The draft must have been made from the catalog as it still is.
      const expected: Record<string, EmojiEntry> = { ...before.entries };
      if (row) expected[name] = draft.entries[name];
      else delete expected[name];
      if (JSON.stringify(expected) !== (draft.json || "{}")) return null;
      if (row) this.completeUploadRow(sql, row, write!.bytes!);
      // The images the last change superseded, which only the previous
      // catalog refers to, go with it: at most the 8 one change supersedes.
      // An image is never referred to again once superseded, since an add
      // always brings a new upload, so this holds even when the catalog
      // returns to the previous one (an add, then a remove of that key).
      const superseded = sql.rows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_pending_idx WHERE state = 'superseded' LIMIT 16`,
      );
      const deletedUploads = this.releaseUploadRows(sql, superseded);
      // The image this change replaces or removes stays, with its bytes,
      // while the catalog before this one does.
      const replaced = sql.rows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_message_idx WHERE message_id = ? AND purpose = 'emoji' AND state = 'done' LIMIT 8`,
        name,
      ).filter((candidate) => candidate.upload_key !== row?.upload_key);
      for (const candidate of replaced) sql.exec("UPDATE uploads SET state = 'superseded' WHERE upload_key = ?", candidate.upload_key);
      sql.writeMeta(META_EMOJI_CATALOG, draft.json || null);
      // The catalog before this one stays until the next change; the one
      // before that goes now.
      const previous = sql.metaValue(META_EMOJI_PREVIOUS);
      if (previous && previous !== draft.key && previous !== before.key) deletedUploads.push(previous);
      if (before.key && before.key !== draft.key) sql.writeMeta(META_EMOJI_PREVIOUS, before.key);
      else if (previous) sql.writeMeta(META_EMOJI_PREVIOUS, null);
      return deletedUploads;
    }));
    if (!result) return { applied: false, deletedUploads: [] };
    this.emojiCache = this.emojiCacheFor(draft.json, draft.entries);
    return { applied: true, deletedUploads: result };
  }

  /**
   * Finishes a write exactly once (protocol §4.8.3). A file's message gets a
   * new snapshot, with the embed completed (`url`, and `og.image` or, for a
   * voice clip, `og.audio` describing it; a text file gets neither) or, for a
   * failed write, without it; an avatar becomes its owner's.
   * A write that is not pending, came too late, or whose embed or message is
   * gone is not accepted, and its object is the caller's to delete.
   */
  /** Who owns an upload (`owner_id`: a user, or SERVER_OWNER or EMOJI_OWNER), or undefined for an unknown key: one row by primary key. */
  uploadOwner(key: string, now = this.core.clock.now()): string | undefined {
    this.core.ensureReady();
    return this.core.reserved("uploadOwner", { reads: 4 }, false, now, (sql) => this.uploadRow(sql, key)?.owner_id);
  }

  finishUpload(write: UploadWrite, now = this.core.clock.now()): UploadFinish {
    this.core.ensureReady();
    // A user's or the server's avatar write scans its owner's uploads for the
    // one it replaces, so the reservation is sized by the owner, read first.
    const owner = this.uploadOwner(write.key, now) ?? "";
    return this.core.reserved("finishUpload", { reads: 96 + this.uploadsPerOwner(owner), writes: 64 + UPLOAD_WRITES }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const row = this.uploadRow(sql, write.key);
      if (!row || row.state !== "writing" || effective > row.write_expires_ms + UPLOAD_WRITE_GRACE_MS) {
        return { accepted: false, broadcasts: [], deletedUploads: [] };
      }
      return this.completeUpload(sql, row, write, effective);
    }));
  }

  /**
   * Claims a pending upload's write for the one request that arrived in its
   * window, before any byte reaches R2: a `write_url` used again is refused,
   * so it cannot overwrite a finished upload. The claim is charged to the
   * server's daily upload count (`uploadsPerDay`); past it, `"closed"`, and
   * the upload stays pending until it is written after the daily reset or
   * its window closes.
   */
  claimUpload(key: string, now = this.core.clock.now()): boolean | "closed" {
    this.core.ensureReady();
    return this.core.reserved("claimUpload", { reads: 16, writes: 16 }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const row = this.uploadRow(sql, key);
      if (!row || row.state !== "pending" || effective > row.write_expires_ms) return false;
      const policy = this.core.config.uploads;
      if (policy) {
        const day = dayFor(effective);
        const global = sql.limitRow("upload", "global", effective);
        const count = dayCount(global, "uploads_day", day);
        if (count >= policy.uploadsPerDay) return "closed";
        sql.updateLimitRow(global, { day, uploads_day: count + 1 }, effective);
      }
      sql.exec("UPDATE uploads SET state = 'writing' WHERE upload_key = ?", key);
      return true;
    }));
  }

  private completeUpload(sql: Sql, row: RawUploadRow, write: UploadWrite, now: number): UploadFinish {
    const ok = write.ok && typeof write.bytes === "number" && write.bytes > 0 && write.bytes <= row.bytes && !!write.contentType;
    const url = `${this.core.config.uploads?.mediaOrigin ?? ""}/${row.upload_key}`;
    // A custom emoji's write is accepted only through emojiDraft and
    // commitEmoji, which publish the catalog first; here it fails.
    if (row.purpose === "emoji") return { accepted: false, broadcasts: [], deletedUploads: this.releaseUploadRows(sql, [row]) };
    if (row.purpose === "avatar") {
      const identity = sql.identityRow(row.owner_id);
      if (!ok || !identity || !write.contentType!.startsWith("image/")) return { accepted: false, broadcasts: [], deletedUploads: this.releaseUploadRows(sql, [row]) };
      this.completeUploadRow(sql, row, write.bytes!);
      const replaced = sql.rows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id = ? AND purpose = 'avatar' AND state = 'done' AND upload_key <> ? LIMIT 8`,
        row.owner_id, row.upload_key,
      );
      sql.exec("UPDATE identities SET avatar_url = ?, avatar_expires_ms = ?, updated_ms = ? WHERE user_id = ?", url, row.expires_ms, now, row.owner_id);
      return { accepted: true, broadcasts: [], avatar: { userId: row.owner_id, url }, deletedUploads: this.releaseUploadRows(sql, replaced) };
    }
    if (row.purpose === "server") {
      if (!ok || !write.contentType!.startsWith("image/")) return { accepted: false, broadcasts: [], deletedUploads: this.releaseUploadRows(sql, [row]) };
      this.completeUploadRow(sql, row, write.bytes!);
      // The avatar it replaces goes at once, as a user's does.
      const replaced = sql.rows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id = ? AND purpose = 'server' AND state = 'done' AND upload_key <> ? LIMIT 8`,
        SERVER_OWNER, row.upload_key,
      );
      this.writeServerField(sql, "avatar", url);
      return { accepted: true, broadcasts: [], serverAvatar: url, deletedUploads: this.releaseUploadRows(sql, replaced) };
    }
    const found = row.message_id && row.embed_id ? sql.retainedEmbed(row.message_id, row.embed_id) : null;
    if (!found) return { accepted: false, broadcasts: [], deletedUploads: this.releaseUploadRows(sql, [row]) };
    const { message, snapshot, embed } = found;
    let replacement: Record<string, unknown> | null = null;
    let deletedUploads: string[] = [];
    if (ok) {
      this.completeUploadRow(sql, row, write.bytes!);
      const size = write.width && write.height ? { width: write.width, height: write.height } : {};
      // A text file has no media to preview: its embed is its title and url.
      const media = write.contentType!.startsWith("audio/") ? { audio: { url, type: write.contentType } } : write.contentType!.startsWith("image/") ? { image: { url, type: write.contentType, ...size } } : {};
      replacement = { ...embed, url, og: { ...(typeof embed.title === "string" ? { title: embed.title } : {}), ...media } };
    } else deletedUploads = this.releaseUploadRows(sql, [row]);
    return { accepted: ok, broadcasts: sql.rewriteEmbed(message, snapshot, row.embed_id!, replacement, now), deletedUploads };
  }

  /**
   * Fails pending uploads whose write never came (protocol §4.8.3): their
   * messages get a snapshot without the embed. Maintenance work, a bounded
   * batch per call; `next` is when the next one falls due.
   */
  expirePendingUploads(now = this.core.clock.now()): { broadcasts: Broadcast[]; deletedUploads: string[]; next?: number } {
    this.core.ensureReady();
    const done = { broadcasts: [] as Broadcast[], deletedUploads: [] as string[] };
    if (!this.core.config.uploads) return done;
    const due = this.core.reserved("expirePendingUploads", { reads: 16 + UPLOAD_SWEEP_BATCH }, true, now, (sql) => sql.rows<RawUploadRow>(
      `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
       FROM uploads INDEXED BY uploads_pending_idx WHERE state IN ('pending', 'writing') AND write_expires_ms < ?
       ORDER BY write_expires_ms LIMIT ?`,
      this.core.effectiveNow(now) - UPLOAD_WRITE_GRACE_MS, UPLOAD_SWEEP_BATCH,
    ));
    for (const row of due) {
      const finished = this.core.reserved("expirePendingUploads", { reads: 96, writes: 64 + UPLOAD_WRITES }, true, now, (sql) => sql.transaction(() => {
        const current = this.uploadRow(sql, row.upload_key);
        return current && current.state !== "done" ? this.completeUpload(sql, current, { key: row.upload_key, ok: false }, this.core.effectiveNow(now)) : null;
      }));
      if (!finished) continue;
      done.broadcasts.push(...finished.broadcasts);
      done.deletedUploads.push(...finished.deletedUploads);
    }
    const next = this.core.reserved("expirePendingUploads", { reads: 8 }, true, now, (sql) => sql.rows<{ due: number | null }>(
      "SELECT MIN(write_expires_ms) AS due FROM uploads INDEXED BY uploads_pending_idx WHERE state IN ('pending', 'writing')",
    )[0]?.due);
    return typeof next === "number" ? { ...done, next: next + UPLOAD_WRITE_GRACE_MS } : done;
  }

  /**
   * When the earliest pending upload's write runs out, grace included, or
   * undefined with none pending: one indexed read, for an alarm that woke
   * without knowing (ApronDemoServer.alarmWorkDue).
   */
  nextUploadDeadline(now = this.core.clock.now()): number | undefined {
    this.core.ensureReady();
    if (!this.core.config.uploads) return undefined;
    const next = this.core.reserved("nextUploadDeadline", { reads: 8 }, true, now, (sql) => sql.rows<{ due: number | null }>(
      "SELECT MIN(write_expires_ms) AS due FROM uploads INDEXED BY uploads_pending_idx WHERE state IN ('pending', 'writing')",
    )[0]?.due);
    return typeof next === "number" ? next + UPLOAD_WRITE_GRACE_MS : undefined;
  }

  /**
   * Forgets uploads past their expiry plus the lifecycle lag, freeing their
   * bytes, and returns their keys for the caller to delete from R2 (a
   * bucket lifecycle rule may already have); an expired avatar leaves its
   * owner. Maintenance work, a bounded batch per call.
   *
   * An attached file's expiry is fixed when it is uploaded, so a longer
   * `fileRetentionSeconds` would not reach files uploaded before it: their
   * messages would outlive them. A written file that the current setting
   * still keeps, and whose message is still kept, is given that expiry
   * instead of being forgotten. Retention cleanup removes a message without
   * releasing its uploads, so a file whose message is gone is not kept on.
   */
  cleanupUploads(now = this.core.clock.now()): { count: number; deleted: string[] } {
    this.core.ensureReady();
    const policy = this.core.config.uploads;
    if (!policy) return { count: 0, deleted: [] };
    // Five reads a row: the four of its release, or the message lookup of an extension.
    return this.core.reserved("cleanupUploads", { reads: 16 + 5 * UPLOAD_SWEEP_BATCH, writes: 8 + 12 * UPLOAD_SWEEP_BATCH }, true, now, (sql) => sql.transaction(() => {
      const rows = sql.rows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms, created_ms
         FROM uploads INDEXED BY uploads_expiry_idx WHERE expires_ms < ? ORDER BY expires_ms LIMIT ?`,
        this.core.effectiveNow(now) - policy.lifecycleLagSeconds * 1_000, UPLOAD_SWEEP_BATCH,
      );
      const expired: RawUploadRow[] = [];
      for (const row of rows) {
        const kept = row.purpose === "file" && row.state === "done" && row.message_id ? integerColumn(row.created_ms) + policy.fileRetentionSeconds * 1_000 : 0;
        const messageKept = kept > row.expires_ms
          && sql.rows<{ found: number }>("SELECT 1 AS found FROM message_state WHERE message_id = ? LIMIT 1", row.message_id).length > 0;
        if (messageKept) sql.exec("UPDATE uploads SET expires_ms = ? WHERE upload_key = ?", kept, row.upload_key);
        else expired.push(row);
      }
      for (const row of expired) {
        if (row.purpose !== "avatar") continue;
        sql.exec(
          "UPDATE identities SET avatar_url = '', avatar_expires_ms = 0 WHERE user_id = ? AND avatar_url = ?",
          row.owner_id, `${policy.mediaOrigin}/${row.upload_key}`,
        );
      }
      // The caller deletes them from R2 as well (deleteMedia), so expired files
      // go even where the bucket has no lifecycle rule; custom emoji and the
      // server's avatar never expire here.
      return { count: rows.length, deleted: this.releaseUploadRows(sql, expired) };
    }));
  }

  /**
   * A user's avatar key when it is due to be written again: live, and within
   * `avatarRefreshSeconds` of its expiry.
   */
  avatarRefreshDue(userId: string, now = this.core.clock.now()): string | null {
    this.core.ensureReady();
    const policy = this.core.config.uploads;
    if (!policy) return null;
    return this.core.reserved("avatarRefreshDue", { reads: 8 }, false, now, (sql) => {
      const row = sql.identityRow(userId);
      const prefix = `${policy.mediaOrigin}/`;
      if (!row?.avatar_url.startsWith(prefix) || row.avatar_expires_ms <= now) return null;
      return row.avatar_expires_ms - now <= policy.avatarRefreshSeconds * 1_000 ? row.avatar_url.slice(prefix.length) : null;
    });
  }

  /** Restarts an avatar's expiry after its object was written again. */
  renewAvatar(input: { userId: string; key: string; now?: number }): void {
    this.core.ensureReady();
    const policy = this.core.config.uploads;
    if (!policy) return;
    const now = input.now ?? this.core.clock.now();
    this.core.reserved("renewAvatar", { reads: 16, writes: 16 }, false, now, (sql) => sql.transaction(() => {
      const expires = this.core.effectiveNow(now) + policy.avatarRetentionSeconds * 1_000;
      sql.exec("UPDATE uploads SET expires_ms = ? WHERE upload_key = ? AND owner_id = ?", expires, input.key, input.userId);
      sql.exec(
        "UPDATE identities SET avatar_expires_ms = ? WHERE user_id = ? AND avatar_url = ?",
        expires, input.userId, `${policy.mediaOrigin}/${input.key}`,
      );
    }));
  }

  /** Removes a user's avatar (`me` with `avatar: ""`, §3.3); returns whether one was set and the keys to delete. */
  clearAvatar(input: { userId: string; now?: number }): { changed: boolean; deletedUploads: string[] } {
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    // The avatar's upload is found by a scan of every upload the user owns (uploadsPerOwner).
    return this.core.reserved("clearAvatar", { reads: 32 + this.uploadsPerOwner(input.userId), writes: 32 }, false, now, (sql) => sql.transaction(() => {
      const identity = sql.identityRow(input.userId);
      const rows = sql.rows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id = ? AND purpose = 'avatar' AND state = 'done' LIMIT 8`,
        input.userId,
      );
      const changed = !!identity?.avatar_url;
      if (changed) sql.exec("UPDATE identities SET avatar_url = '', avatar_expires_ms = 0, updated_ms = ? WHERE user_id = ?", this.core.effectiveNow(now), input.userId);
      return { changed, deletedUploads: this.releaseUploadRows(sql, rows) };
    }));
  }
}
