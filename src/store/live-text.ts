/*
 * Live text (protocol §4.8.3): the open texts, kept as one `_meta` record
 * (META_LIVE_TEXTS) and cached; starting one (a command, or a message's
 * live embed, which the commit path starts here), claiming its write (which
 * posts or republishes its message through the commit path), finishing it
 * (its output to R2 through the uploads module, or inline) and expiring it.
 * The LiveText part delegates here.
 */

import { uploadTitle } from "../content/embeds";
import { LIVE_TEXT_LONG_ROLES } from "../domain";
import { type LiveKind, keepAppend, keepLast, liveDeadline, liveHolds, liveTextString, terminalOutput } from "../live-text";
import { StoreError } from "../store-error";
import { LIVE_WRITES } from "./limits";
import { META_LIVE_TEXTS, META_TOGGLE_PREFIX } from "./meta";
import { clone, ensureText, isLiveEntry, liveUrl, randomKey, utf8Bytes } from "./rows";
import type { Broadcast, Identity, LiveEntry, LiveFinish, MessageSnapshot, StoreMutationInput, TerminalStored, Tier } from "./types";
import type { Sql, StoreCore } from "./core";
import type { AdmissionModule } from "./admission";
import type { UploadsModule } from "./uploads";

/** Live text over the store's core: the LiveText part's implementation, and the live embeds the commit path starts and drops. */
export class LiveTextModule {
  constructor(private readonly core: StoreCore, private readonly admission: AdmissionModule, private readonly uploads: UploadsModule) {
    // A transaction that rolls back puts back the open texts it saved.
    let saved: LiveEntry[] | undefined;
    core.journal({ begin: () => { saved = this.liveCache; }, commit: () => {}, rollback: () => { this.liveCache = saved; } });
  }

  /**
   * The open live texts (META_LIVE_TEXTS) as last read or saved, undefined
   * until read: every change goes through this instance, and a rolled-back
   * transaction restores it.
   */
  liveCache: LiveEntry[] | undefined;

  /** The open live texts (META_LIVE_TEXTS): one `_meta` row, absent while there are none. */
  liveTexts(sql: Sql): LiveEntry[] {
    if (!this.liveCache) {
      this.liveCache = sql.metaJson(META_LIVE_TEXTS, (value) => Array.isArray(value) ? value.filter(isLiveEntry) : undefined, []);
    }
    // Callers change what they get before they save it.
    return clone(this.liveCache) as LiveEntry[];
  }

  private saveLiveTexts(sql: Sql, entries: readonly LiveEntry[]): void {
    sql.writeMeta(META_LIVE_TEXTS, entries.length ? JSON.stringify(entries) : null);
    this.liveCache = clone(entries) as LiveEntry[];
  }

  /** Forgets the open live texts `match` picks, publishing nothing; returns their write keys. */
  dropLiveTexts(sql: Sql, match: (entry: LiveEntry) => boolean): string[] {
    const entries = this.liveTexts(sql);
    const gone = entries.filter(match);
    if (gone.length) this.saveLiveTexts(sql, entries.filter((entry) => !match(entry)));
    return gone.map((entry) => entry.key);
  }

  /** Live text: configured, and on unless an admin turned it off (or on, against the default). */
  private liveTextOn(sql: Sql): boolean {
    const live = this.core.config.liveText;
    if (!live) return false;
    const value = sql.metaValue(META_TOGGLE_PREFIX + "livetext");
    return value === "on" ? true : value === "off" ? false : live.enabled;
  }

  /**
   * Starts a live text (§4.8.3) within the policy: one open text per user,
   * unexpired pending writes included; at most `concurrent` server-wide (liveHolds); and the
   * user's (a guest's: their IP's), the IP's and the server's starts,
   * charged as `live` limiter rows (a burst, then a rate, and a count a UTC
   * day). Its time limit is the owner's: `moderatorMaxSeconds` for an
   * `admin` or `mod`, else `maxSeconds`. An append may add what the message
   * text limit leaves of `text`, at most `appendMaxBytes`.
   */
  startLiveText(sql: Sql, kind: LiveKind, input: Pick<StoreMutationInput, "userId" | "ipKey">, now: number, link: { messageId?: string; embedId: string; text: string; post?: LiveEntry["post"] }): LiveEntry {
    const policy = this.core.config.liveText;
    if (!policy) throw new StoreError("unsupported", "Live text is not available here");
    if (!this.liveTextOn(sql)) throw new StoreError("denied", "Live text is turned off here");
    this.core.assertNotDegraded("Live text", now);
    // A command's write that never came leaves nothing to publish: it goes now.
    const entries = this.liveTexts(sql).filter((entry) => entry.post === undefined || entry.writeExpiresMs >= now);
    // Only a text that can still stream holds a slot (liveHolds). One whose
    // write_url expired stays listed until the alarm ends its message
    // (expireLiveTexts), but no longer counts against its owner or the server;
    // the list itself stays bounded, at twice the concurrent texts.
    const holding = entries.filter((entry) => liveHolds(entry, now));
    if (holding.some((entry) => entry.owner === input.userId)) {
      throw new StoreError("denied", "You already have a live text open; finish it, or let its write_url expire, before you start another");
    }
    if (holding.length >= policy.concurrent || entries.length >= 2 * policy.concurrent) {
      const soonest = Math.min(...(holding.length ? holding : entries).map(liveDeadline));
      throw new StoreError("retry_after", "Live text is busy on this server; try again shortly", { retryAfterMs: Math.max(1_000, soonest - now) });
    }
    const limit = kind === "terminal" ? policy.terminalKeepBytes : Math.min(policy.appendMaxBytes, this.core.config.maxTextBytes - utf8Bytes(link.text));
    if (limit <= 0) throw new StoreError("too_large", "The message text leaves no room to append to");
    const registered = sql.identityRow(input.userId) !== null;
    const principal = registered ? `user:${input.userId}` : `anonymous:${input.ipKey}`;
    const window = policy.startWindowMinutes;
    this.admission.chargeEvent(sql, "live", principal, now, { perMinute: policy.startsPerUser / window, burst: policy.startsPerUser }, "Live text limit reached",
      { limit: policy.startsPerUserDay, message: "Daily live text limit reached" });
    this.admission.chargeEvent(sql, "live", `ip:${input.ipKey}`, now, { perMinute: policy.startsPerIp / window, burst: policy.startsPerIp }, "Live text limit reached");
    this.admission.chargeEvent(sql, "live", "global", now, { perMinute: policy.startsPerDay }, "Daily live text limit reached for the server",
      { limit: policy.startsPerDay, message: "Daily live text limit reached for the server" });
    const long = registered && sql.holdsRole(input.userId, LIVE_TEXT_LONG_ROLES);
    const entry: LiveEntry = {
      key: `l/${randomKey()}`,
      id: randomKey(),
      kind,
      owner: input.userId,
      ip: input.ipKey,
      state: "pending",
      writeExpiresMs: now + policy.writeWindowSeconds * 1_000,
      maxMs: (long ? policy.moderatorMaxSeconds : policy.maxSeconds) * 1_000,
      limit,
      embedId: link.embedId,
      ...(link.messageId !== undefined ? { messageId: link.messageId } : {}),
      ...(link.post ? { post: link.post } : {}),
    };
    this.saveLiveTexts(sql, [...entries, entry]);
    return entry;
  }

  /**
   * The open live texts: one `_meta` row read the first time after a wake,
   * then from memory, since every change goes through this instance
   * (liveCache), so a reader's `GET` of an ended text costs no SQL.
   */
  openLiveTexts(now = this.core.clock.now()): LiveEntry[] {
    this.core.ensureReady();
    if (!this.core.config.liveText) return [];
    // Callers change what they get before they save it.
    if (this.liveCache) return clone(this.liveCache) as LiveEntry[];
    return this.core.reserved("openLiveTexts", { reads: 4 }, false, now, (sql) => this.liveTexts(sql));
  }

  /**
   * `/embed-terminal [title]` and `/embed-append [markdown]`: a live text
   * whose message is posted when its write arrives (claimLiveText), from
   * `userId`, in `roomId`, replying to `replyTo`. Everything is checked and
   * charged now, its post included (the posting limits), so the write
   * cannot be refused for them later.
   */
  startLiveCommand(input: { userId: string; ipKey: string; identity: Identity; kind: LiveKind; roomId: string; title?: string; text?: string; replyTo?: string; now?: number }): LiveEntry {
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    return this.core.reserved("startLiveCommand", { reads: 64, writes: 48 + LIVE_WRITES }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      if (!sql.visibleRoomRow(input.roomId, input.userId)) throw new StoreError("invalid_params", "unknown room");
      const text = ensureText(input.text ?? "", "body.text", this.core.config.maxTextBytes);
      const replyTo = input.replyTo === undefined ? undefined
        : sql.messageReference({ message_id: input.replyTo }, "reply_to", sql.logState().history_floor, { viewer: input.userId, roomId: input.roomId });
      const title = input.kind === "terminal" ? uploadTitle(input.title) : undefined;
      const tier: Tier = sql.identityRow(input.userId) ? "registered" : "anonymous";
      this.admission.chargePosting(sql, { userId: input.userId, tier, ipKey: input.ipKey, now: effective });
      return this.startLiveText(sql, input.kind, input, effective, {
        embedId: `embed_${randomKey()}`,
        text,
        post: { roomId: input.roomId, ...(title ? { title } : {}), ...(text ? { text } : {}), ...(replyTo ? { replyTo } : {}), identity: clone(input.identity) },
      });
    }));
  }

  /**
   * The write of a live text arrived (§4.8.3): a pending one within its
   * window starts streaming, once. A command's message is posted now, with
   * the embed's `url`; a message's is republished with it (§4.8.5). Null
   * when the write cannot start: unknown, used, or expired. A command's
   * message that can no longer be posted (its room or reply gone) throws,
   * and its text is forgotten.
   */
  claimLiveText(key: string, now = this.core.clock.now()): { entry: LiveEntry; broadcasts: Broadcast[]; message?: MessageSnapshot } | null {
    this.core.ensureReady();
    if (!this.core.config.liveText) return null;
    try {
      return this.core.reserved("claimLiveText", { reads: 256, writes: 96 + LIVE_WRITES }, false, now, (sql) => sql.transaction(() => {
        const effective = this.core.effectiveNow(now);
        const entries = this.liveTexts(sql);
        const entry = entries.find((candidate) => candidate.key === key);
        if (!entry || entry.state !== "pending" || effective > entry.writeExpiresMs) return null;
        let broadcasts: Broadcast[] = [];
        let message: MessageSnapshot | undefined;
        if (entry.post) {
          sql.ensureGrowthCapacity(this.core.config.maxSnapshotBytes);
          const post = entry.post;
          const params: Record<string, unknown> = {
            room_id: post.roomId,
            body: {
              text: post.text ?? "",
              ...(entry.kind === "append" ? { format: "markdown" } : {}),
              embeds: [{ kind: entry.kind, ...(post.title ? { title: post.title } : {}) }],
            },
            ...(post.replyTo ? { reply_to: { message_id: post.replyTo } } : {}),
          };
          const committed = sql.commitLivePost({ userId: entry.owner, ipKey: entry.ip, params, identity: post.identity }, effective, entry);
          broadcasts = committed.broadcasts;
          message = committed.message;
          entry.messageId = message!.message_id;
          delete entry.post;
        } else if (entry.messageId) {
          const found = sql.retainedEmbed(entry.messageId, entry.embedId);
          if (found) {
            sql.ensureGrowthCapacity(this.core.config.maxSnapshotBytes);
            broadcasts = sql.rewriteEmbed(found.message, found.snapshot, entry.embedId, { ...found.embed, url: liveUrl(this.core.config.liveText!, entry) }, effective);
          }
        }
        entry.state = "live";
        entry.startedMs = effective;
        this.saveLiveTexts(sql, entries);
        return { entry, broadcasts, ...(message ? { message } : {}) };
      }));
    } catch (error) {
      // A message that cannot be posted any more will not be later either.
      if (error instanceof StoreError && ["invalid_params", "denied", "too_large"].includes(error.code)) {
        this.core.reserved("claimLiveText", { reads: 4, writes: 4 }, true, now, (sql) => sql.transaction(() => this.dropLiveTexts(sql, (entry) => entry.key === key)));
      }
      throw error;
    }
  }

  /**
   * Ends a live text exactly once (§4.8.3) and publishes what it kept: a
   * terminal's message gets its embed with `output` (§4.8.6), and an
   * append's the kept text, after its edits, appended to `body.text` and
   * its embed removed (§4.8.5); with nothing kept, the embed is removed (a
   * message left with nothing is a tombstone). A text already ended, or whose message or
   * embed is gone, publishes nothing. Finishing work already admitted, it is
   * charged as maintenance, so an exhausted foreground budget cannot lose it.
   */
  finishLiveText(key: string, kept: Uint8Array | null, now = this.core.clock.now(), stored?: TerminalStored): LiveFinish {
    this.core.ensureReady();
    if (!this.core.config.liveText) return { broadcasts: [] };
    // A stored output adds its upload row and the stored-bytes count.
    return this.core.reserved("finishLiveText", { reads: 96 + (stored ? 16 : 0), writes: 64 + LIVE_WRITES + (stored ? 16 : 0) }, true, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const entries = this.liveTexts(sql);
      const entry = entries.find((candidate) => candidate.key === key);
      if (!entry) return { broadcasts: [] };
      this.saveLiveTexts(sql, entries.filter((candidate) => candidate !== entry));
      const published = { stored: false };
      const broadcasts = this.publishLiveText(sql, entry, kept, effective, stored, published);
      return { entry, broadcasts, stored: published.stored };
    }));
  }

  /**
   * Ends the live texts that fell due: a write that never came by its
   * window's end (its message, if posted, loses the embed), and a text
   * marked streaming that `streaming` (the runtime's own) does not hold:
   * the object that streamed it was evicted or redeployed and its bytes are
   * gone, so its embed is removed. Maintenance work, bounded by twice
   * `concurrent` entries (startLiveText), which its reservation covers; `next` is when the next one falls due.
   */
  expireLiveTexts(streaming: ReadonlySet<string>, now = this.core.clock.now()): { broadcasts: Broadcast[]; ended: LiveEntry[]; next?: number } {
    this.core.ensureReady();
    if (!this.core.config.liveText) return { broadcasts: [], ended: [] };
    // Known to be none: nothing to read or reserve, so the alarm pays nothing for the feature.
    if (this.liveCache?.length === 0) return { broadcasts: [], ended: [] };
    return this.core.reserved("expireLiveTexts", { reads: 32 + 64 * this.core.config.liveText.concurrent, writes: 8 + 32 * this.core.config.liveText.concurrent }, true, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const entries = this.liveTexts(sql);
      const due = entries.filter((entry) => entry.state === "pending" ? effective > entry.writeExpiresMs : !streaming.has(entry.key));
      const remaining = entries.filter((entry) => !due.includes(entry));
      const next = remaining.length ? Math.min(...remaining.map(liveDeadline)) : undefined;
      if (!due.length) return { broadcasts: [], ended: [], ...(next !== undefined ? { next } : {}) };
      this.saveLiveTexts(sql, remaining);
      const broadcasts = due.flatMap((entry) => this.publishLiveText(sql, entry, null, effective));
      return { broadcasts, ended: due, ...(next !== undefined ? { next } : {}) };
    }));
  }

  /**
   * The snapshot that ends a live text (finishLiveText). A terminal's output
   * the runtime stored in R2 (`stored`) is kept there, the snapshot holding
   * a TerminalOutputRef to it and its upload row counting its bytes like an
   * attached file's, while uploads are on and their stored-bytes cap allows;
   * otherwise in the snapshot, as `output`.
   */
  private publishLiveText(sql: Sql, entry: LiveEntry, kept: Uint8Array | null, now: number, stored?: TerminalStored, published?: { stored: boolean }): Broadcast[] {
    if (!entry.messageId) return [];
    const found = sql.retainedEmbed(entry.messageId, entry.embedId);
    if (!found) return [];
    const { message, snapshot, embed } = found;
    // What the entry keeps, whatever the caller held: the last part of a terminal, the first of an append.
    if (entry.kind === "terminal") {
      const output = terminalOutput(keepLast(kept ?? new Uint8Array(0), entry.limit));
      // Its `url` ends with the text: the output is the embed's now (§4.8.6).
      const { url: _url, ...rest } = embed;
      void _url;
      if (!output) return sql.rewriteEmbed(message, snapshot, entry.embedId, null, now);
      const ref = stored && stored.output === output ? this.uploads.storeTerminalOutput(sql, stored, entry, now) : undefined;
      if (ref && published) published.stored = true;
      return sql.rewriteEmbed(message, snapshot, entry.embedId, ref ? { ...rest, output_ref: ref } : { ...rest, output }, now);
    }
    const base = typeof snapshot.body?.text === "string" ? snapshot.body.text : "";
    // A save may have lengthened the text while it streamed: the body stays within the text limit.
    // The edits (§4.8.5) apply to the appended text only, never to `base`.
    const room = Math.max(0, this.core.config.maxTextBytes - utf8Bytes(base));
    const added = keepAppend(kept ?? new Uint8Array(0), Math.min(entry.limit, room));
    return sql.rewriteEmbed(message, snapshot, entry.embedId, null, now, base + liveTextString(added));
  }
}
