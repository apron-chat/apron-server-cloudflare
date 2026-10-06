import { expect, it } from "vitest";
import { RETENTION_MS, Store, StoreError, type StoreConfig, type StoreMutationInput, type StoreMutationResult } from "../src/store";
import { errorCode, expectRetryAfter, messagesOf, withStore as withNamedStore, type TestClock } from "./helpers/store";

// Semantics tests use roomy posting windows; quota tests below use tiny ones.
const ROOMY: Partial<StoreConfig> = {
	anonymousPostsPerMinute: 1_000,
	anonymousPostsPerDay: 1_000,
	ipPostsPerMinute: 1_000,
	ipPostsPerDay: 1_000,
	globalPostsPerMinute: 1_000,
	globalPostsPerDay: 5_000,
};

const withStore = <T>(name: string, fn: Parameters<typeof withNamedStore<T>>[2], config: Partial<StoreConfig> = ROOMY) =>
	withNamedStore(`mutation-${name}`, config, fn);

function op(clock: TestClock, userId: string, requestId: string, method: string, params: Record<string, unknown>): StoreMutationInput {
	return {
		userId,
		ipKey: "ip-test",
		requestId,
		method,
		now: clock.value,
		params,
		identity: { user_id: userId, name: userId === "alice" ? "Alice" : "Bob" },
	};
}

const post = (store: Store, clock: TestClock, userId: string, requestId: string, params: Record<string, unknown>) =>
	store.mutate(op(clock, userId, requestId, "message", { room_id: "general", ...params }));

function logOf(result: StoreMutationResult): number {
	const logId = result.broadcasts[0]?.params.log_id ?? result.room?.log_id;
	if (typeof logId !== "string") throw new Error("mutation produced no record");
	return Number(logId);
}

function thread(store: Store, clock: TestClock, requestId: string, params: Record<string, unknown> = {}): string {
	const created = store.mutate(op(clock, "alice", requestId, "room_set", { parent_room_id: "general", title: "Thread", ...params }));
	return String(created.result.room_id);
}

it("allocates one strictly increasing log sequence across rooms, record kinds, and clocks", async () => {
	await withStore("sequence", (store, clock) => {
		const general = store.getRoomState();
		const first = post(store, clock, "alice", "s1", { body: { text: "one" } });
		expect(first.message?.message_id).toBe(first.message?.log_id);
		const roomResult = store.mutate(op(clock, "alice", "s2", "room_set", { parent_room_id: "general", title: "Side" }));
		const threadId = String(roomResult.result.room_id);
		// This server uses a room's creation log_id as its room_id.
		expect(roomResult.room?.log_id).toBe(threadId);
		const inThread = store.mutate(op(clock, "alice", "s3", "message", { room_id: threadId, body: { text: "two" } }));
		const reacted = store.mutate(op(clock, "bob", "s4", "reactions", { message_id: first.result.message_id, emojis: ["👍"] }));
		clock.value -= 10_000;
		const backward = post(store, clock, "alice", "s5", { body: { text: "three" } });

		const logs = [Number(general.log_id), logOf(first), logOf(roomResult), logOf(inThread), logOf(reacted), logOf(backward)];
		for (let index = 1; index < logs.length; index += 1) expect(logs[index]).toBeGreaterThan(logs[index - 1]);
		expect(store.logBounds().latest_log_id).toBe(String(logs.at(-1)));
		expect(store.getRoomState().latest_log_id).toBe(String(logs.at(-1)));
		expect(store.getRoomState(threadId).latest_log_id).toBe(String(logOf(inThread)));
		// Message IDs are globally unique: equal to the creation log_id.
		expect(inThread.message?.message_id).toBe(String(logOf(inThread)));
	});
});

it("keeps an embed's og as plain text fields and drops the rest", async () => {
	await withStore("og", (store, clock) => {
		const url = "https://github.com/apron-chat/apron-web/pull/11";
		const long = "x".repeat(300);
		const created = post(store, clock, "alice", "og1", {
			body: {
				text: url,
				embeds: [
					{
						kind: "link", url,
						og: {
							site_name: "GitHub · apron-chat/apron-web",
							title: ` Preview\u202e links\n\tbuilt  in the browser `,
							description: long + long,
							image: { url: "https://evil.example/pixel.png" },
							type: "website",
						},
					},
					{ kind: "link", url: "https://example.com", og: { image: { url: "https://evil.example/x.png" }, title: " \n " } },
					{ kind: "link", url: "https://example.com/a", og: "not an object" },
					{ kind: "html", html: "<b>opaque</b>" },
				],
			},
		});
		const embeds = created.message?.body?.embeds as Record<string, unknown>[];
		expect(embeds[0]).toEqual({
			kind: "link", url,
			og: { title: "Preview links built in the browser", description: `${"x".repeat(511)}…`, site_name: "GitHub · apron-chat/apron-web" },
		});
		expect(embeds[1]).toEqual({ kind: "link", url: "https://example.com" });
		expect(embeds[2]).toEqual({ kind: "link", url: "https://example.com/a" });
		expect(embeds[3]).toEqual({ kind: "html", html: "<b>opaque</b>" });

		expect(errorCode(() => post(store, clock, "alice", "og2", { body: { text: "x", embeds: ["link"] } }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "og3", { body: { text: "x", embeds: [{ url }] } }))).toBe("invalid_params");
	});
});

it("keeps og media from other servers only with ogRemoteMedia", async () => {
	await withStore("og-media", (store, clock) => {
		const created = post(store, clock, "alice", "ogm1", {
			body: {
				text: "look",
				embeds: [{
					kind: "link", url: "https://example.com",
					og: {
						title: "Example",
						image: { url: "https://cdn.example/a.png", type: "image/png", width: 320, height: -1, alt: "An\nexample", extra: true },
						video: { url: "javascript:alert(1)" },
						audio: "https://cdn.example/a.mp3",
					},
				}],
			},
		});
		expect((created.message?.body?.embeds as unknown[])[0]).toEqual({
			kind: "link", url: "https://example.com",
			og: { title: "Example", image: { url: "https://cdn.example/a.png", type: "image/png", width: 320, alt: "An example" } },
		});
	}, { ...ROOMY, ogRemoteMedia: true });
});

it("broadcasts flat self-describing snapshots and enforces replacement semantics", async () => {
	await withStore("edits", (store, clock) => {
		const created = post(store, clock, "alice", "m1", {
			body: { text: "original" },
			ext: { irc: { nick: "ada_" } },
			unknown_top_level: "dropped",
		});
		const messageId = String(created.result.message_id);
		expect(created.broadcasts).toHaveLength(1);
		expect(created.broadcasts[0]).toEqual({
			method: "message",
			params: {
				message_id: messageId, log_id: messageId, room_id: "general",
				from: { user_id: "alice", name: "Alice" },
				body: { text: "original", format: "plain", embeds: [] },
				ext: { irc: { nick: "ada_" } },
			},
			// Delivered to the members of the room it is in.
			rooms: ["general"],
		});

		const edited = post(store, clock, "alice", "m2", { message_id: messageId, body: { text: "replacement", format: "markdown" } });
		expect(edited.message).toMatchObject({ message_id: messageId, room_id: "general", from: { user_id: "alice" } });
		expect(Number(edited.message?.log_id)).toBeGreaterThan(Number(messageId));
		// A save that leaves `ext` out keeps it: writes merge `ext` (§3.5).
		expect(edited.message?.ext).toEqual({ irc: { nick: "ada_" } });
		expect(edited.message?.body).toEqual({ text: "replacement", format: "markdown", embeds: [] });

		expect(errorCode(() => post(store, clock, "bob", "spoof", { message_id: messageId, body: { text: "spoofed" } }))).toBe("denied");
		expect(errorCode(() => post(store, clock, "alice", "missing", { message_id: "999", body: { text: "x" } }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "no-body", { message_id: messageId }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "born-deleted", { deleted: true }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "log-id", { body: { text: "x" }, log_id: "1" }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "bad-ext", { body: { text: "x" }, ext: ["not", "object"] }))).toBe("invalid_params");
		// Without room_id a message goes to the default room (§3.5).
		expect(store.mutate(op(clock, "alice", "no-room", "message", { body: { text: "x" } })).message?.room_id).toBe("general");
		expect(errorCode(() => store.mutate(op(clock, "alice", "bad-room-type", "message", { room_id: 7, body: { text: "x" } })))).toBe("invalid_params");
		// An empty save is refused by local policy; delete instead.
		expect(errorCode(() => post(store, clock, "alice", "empty-save", { message_id: messageId, body: { text: "" } }))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "alice", "bad-room", "message", { room_id: "private", body: { text: "x" } })))).toBe("invalid_params");

		const deleted = post(store, clock, "alice", "m3", { message_id: messageId, deleted: true, body: { text: "ignored" }, ext: { keep: true } });
		expect(deleted.message?.deleted).toBe(true);
		expect(deleted.message?.body).toBeUndefined();
		// A tombstone carries no body and no ext (§4.6), whatever the save sent.
		expect(deleted.message).not.toHaveProperty("ext");

		const restored = post(store, clock, "alice", "m4", { message_id: messageId, deleted: false, body: { text: "restored" } });
		expect(restored.message?.deleted).toBeUndefined();
		expect(restored.message?.body?.text).toBe("restored");
		// The tombstone kept none, so there is nothing to merge into.
		expect(restored.message).not.toHaveProperty("ext");
	});
});

it("merges ext one level deep on message saves and room_set (§3.5)", async () => {
	await withStore("ext-merge", (store, clock) => {
		const created = post(store, clock, "alice", "e1", {
			body: { text: "x" },
			// An empty value on creation stores nothing; `null` is an ordinary value.
			ext: { irc: { nick: "ada_" }, bridge: { id: 1 }, gone: "", none: null },
		});
		const messageId = String(created.result.message_id);
		expect(created.message?.ext).toEqual({ irc: { nick: "ada_" }, bridge: { id: 1 }, none: null });

		// Each key carried replaces the stored value whole; an empty one clears it; others stay.
		const merged = post(store, clock, "alice", "e2", {
			message_id: messageId, body: { text: "x" },
			ext: { irc: { channel: "#ops" }, bridge: {}, none: [], added: false },
		});
		expect(merged.message?.ext).toEqual({ irc: { channel: "#ops" }, added: false });

		// `"ext": {}` changes nothing.
		const unchanged = post(store, clock, "alice", "e3", { message_id: messageId, body: { text: "y" }, ext: {} });
		expect(unchanged.message?.ext).toEqual({ irc: { channel: "#ops" }, added: false });

		// Clearing every key leaves no ext at all.
		const cleared = post(store, clock, "alice", "e4", { message_id: messageId, body: { text: "y" }, ext: { irc: "", added: [] } });
		expect(cleared.message).not.toHaveProperty("ext");

		// A "__proto__" key is ordinary data, never a prototype.
		const proto = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}') as Record<string, unknown>;
		const hostile = post(store, clock, "alice", "e5", { message_id: messageId, body: { text: "y" }, ext: proto });
		expect(Object.hasOwn(hostile.message!.ext!, "__proto__")).toBe(true);
		expect(JSON.parse(JSON.stringify(hostile.message!.ext))).toEqual(JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}'));
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		const kept = post(store, clock, "alice", "e6", { message_id: messageId, body: { text: "z" }, ext: { safe: 2 } });
		expect(JSON.parse(JSON.stringify(kept.message!.ext))).toEqual(JSON.parse('{"__proto__": {"polluted": true}, "safe": 2}'));

		// The size check runs on the merged snapshot: a write that fits alone fails merged.
		const half = "x".repeat(3_000);
		post(store, clock, "alice", "e7", { message_id: messageId, body: { text: "z" }, ext: { a: half } });
		post(store, clock, "alice", "e8", { message_id: messageId, body: { text: "z" }, ext: { a: "", b: half } });
		expect(errorCode(() => post(store, clock, "alice", "e9", { message_id: messageId, body: { text: "z" }, ext: { a: half, c: half } }))).toBe("too_large");

		// room_set merges the same way, and checks the merged fields' size.
		const roomId = thread(store, clock, "r1", { ext: { demo: { color: "blue" }, other: 1 } });
		const saved = store.mutate(op(clock, "alice", "r2", "room_set", { room_id: roomId, title: "T", ext: { other: "", more: true } }));
		expect(saved.room?.ext).toEqual({ demo: { color: "blue" }, more: true });
		const keptRoom = store.mutate(op(clock, "alice", "r3", "room_set", { room_id: roomId, title: "T" }));
		expect(keptRoom.room?.ext).toEqual({ demo: { color: "blue" }, more: true });
		const big = "y".repeat(1_200);
		store.mutate(op(clock, "alice", "r4", "room_set", { room_id: roomId, title: "T", ext: { big } }));
		expect(errorCode(() => store.mutate(op(clock, "alice", "r5", "room_set", { room_id: roomId, title: "T", ext: { bigger: big } })))).toBe("too_large");
		const emptied = store.mutate(op(clock, "alice", "r6", "room_set", { room_id: roomId, title: "T", ext: { demo: {}, more: "", big: "" } }));
		expect(emptied.room).not.toHaveProperty("ext");
	});
});

it("validates bare reply_to references across rooms", async () => {
	await withStore("replies", (store, clock) => {
		const root = post(store, clock, "alice", "root", { body: { text: "root" } });
		const rootId = String(root.result.message_id);
		const threadId = thread(store, clock, "thread", { description: "About root" });

		expect(errorCode(() => post(store, clock, "alice", "bad-reply", { body: { text: "bad" }, reply_to: { message_id: "404" } }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "bare-string", { body: { text: "bad" }, reply_to: rootId }))).toBe("invalid_params");
		expect(errorCode(() => post(store, clock, "alice", "self", { message_id: rootId, body: { text: "self" }, reply_to: { message_id: rootId } }))).toBe("invalid_params");

		// The target may live in another room; the server keeps only the ID.
		const reply = store.mutate(op(clock, "bob", "reply", "message", {
			room_id: threadId,
			body: { text: "in thread" },
			reply_to: { message_id: rootId, body: { text: "client copy" } },
		}));
		expect(reply.message?.reply_to).toEqual({ message_id: rootId });
		expect(reply.message?.room_id).toBe(threadId);

		// Saves replace every client field: omitting reply_to removes it.
		const cleared = store.mutate(op(clock, "bob", "clear-reply", "message", {
			message_id: reply.result.message_id, room_id: threadId, body: { text: "no reply" },
		}));
		expect(cleared.message?.reply_to).toBeUndefined();
	});
});

it("keeps an unchanged reply reference editable after its target expires", async () => {
	await withStore("reply-expiry", (store, clock) => {
		const target = post(store, clock, "alice", "target", { body: { text: "old target" } });
		const targetId = String(target.result.message_id);
		clock.value += 60 * 60 * 1_000;
		const reply = post(store, clock, "alice", "reply", { body: { text: "reply" }, reply_to: { message_id: targetId } });
		clock.value += RETENTION_MS - 30 * 60 * 1_000;
		store.runCleanup(clock.value);
		expect(errorCode(() => post(store, clock, "alice", "new-reply", { body: { text: "late" }, reply_to: { message_id: targetId } }))).toBe("invalid_params");
		const edited = post(store, clock, "alice", "edit", { message_id: reply.result.message_id, body: { text: "edited" }, reply_to: { message_id: targetId } });
		expect(edited.message?.reply_to).toEqual({ message_id: targetId });
	});
});

it("creates only thread rooms and replaces their client fields on save", async () => {
	await withStore("rooms", (store, clock) => {
		expect(errorCode(() => store.mutate(op(clock, "alice", "top", "room_set", { title: "Top level" })))).toBe("denied");
		expect(errorCode(() => store.mutate(op(clock, "alice", "orphan", "room_set", { parent_room_id: "missing", title: "x" })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "alice", "bad-title", "room_set", { parent_room_id: "general", title: 7 })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "alice", "bad-description", "room_set", { parent_room_id: "general", description: { text: "x" } })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "alice", "long-description", "room_set", { parent_room_id: "general", description: "x".repeat(4096) })))).toBe("too_large");
		// No room is private here, so asking for one is unsupported (§4.3.4).
		expect(errorCode(() => store.mutate(op(clock, "alice", "private", "room_set", { parent_room_id: "general", private: true })))).toBe("unsupported");
		expect(errorCode(() => store.mutate(op(clock, "alice", "bad-private", "room_set", { parent_room_id: "general", private: "yes" })))).toBe("invalid_params");

		const created = store.mutate(op(clock, "bob", "create", "room_set", {
			parent_room_id: "general", title: "Deploy", description: "Deploy chatter: *incidents* too", private: false, ext: { demo: { color: "blue" } },
		}));
		const roomId = String(created.result.room_id);
		// Room records are not broadcast; the runtime sends room_update.
		expect(created.broadcasts).toEqual([]);
		expect(created.created).toBe(true);
		expect(created.room).toEqual({
			room_id: roomId, log_id: roomId, parent_room_id: "general", title: "Deploy",
			description: "Deploy chatter: *incidents* too",
			ext: { demo: { color: "blue" } },
			latest_log_id: roomId, history_log_id: roomId,
		});
		expect(errorCode(() => store.mutate(op(clock, "alice", "nested", "room_set", { parent_room_id: roomId, title: "Nested" })))).toBe("denied");

		// Any participant may save a thread's metadata; omitted fields are
		// cleared but `ext`, which merges (§3.5), the server supplies a title,
		// and parent_room_id and private are fixed.
		const saved = store.mutate(op(clock, "alice", "save", "room_set", { room_id: roomId, parent_room_id: "elsewhere", private: true }));
		expect(saved.result).toEqual({ room_id: roomId });
		expect(saved.created).toBe(false);
		expect(saved.room).toMatchObject({ room_id: roomId, parent_room_id: "general", title: "Thread" });
		expect(saved.room?.description).toBeUndefined();
		expect(saved.room).not.toHaveProperty("private");
		expect(saved.room?.ext).toEqual({ demo: { color: "blue" } });
		expect(Number(saved.room?.log_id)).toBeGreaterThan(Number(roomId));
		expect(saved.room?.latest_log_id).toBe(saved.room?.log_id);
		expect(saved.room?.history_log_id).toBe(roomId);

		expect(errorCode(() => store.mutate(op(clock, "alice", "general", "room_set", { room_id: "general", title: "Renamed" })))).toBe("denied");
		expect(errorCode(() => store.mutate(op(clock, "alice", "unknown", "room_set", { room_id: "404", title: "x" })))).toBe("invalid_params");

		// Room records are logged in their own room.
		const history = store.historyPage({ roomId, after: "0", limit: 50, now: clock.value });
		expect(history.rooms?.map((room) => room.log_id)).toEqual([roomId, saved.room?.log_id]);
		expect(history.rooms?.[0]).toMatchObject({ title: "Deploy", description: "Deploy chatter: *incidents* too" });
		expect(history.messages).toBeUndefined();
		expect(store.listRooms().map((room) => room.room_id)).toEqual(["general", roomId]);
	});
});

it("denies thread creation beyond the thread ceiling", async () => {
	await withStore("thread-limit", (store, clock) => {
		thread(store, clock, "first");
		try {
			thread(store, clock, "second");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(StoreError);
			expect((error as StoreError).code).toBe("denied");
			expect((error as StoreError).message).toBe("thread_limit");
		}
	}, { ...ROOMY, maxThreads: 1 });
});

it("moves a message into both rooms' logs and re-logs its reactions in the destination", async () => {
	await withStore("moves", (store, clock) => {
		const original = post(store, clock, "alice", "original", { body: { text: "misplaced" } });
		const messageId = String(original.result.message_id);
		store.mutate(op(clock, "alice", "react-a", "reactions", { message_id: messageId, emojis: ["👍"] }));
		store.mutate(op(clock, "bob", "react-b", "reactions", { message_id: messageId, emojis: ["🎉", "👀"] }));
		const threadId = thread(store, clock, "thread");

		expect(errorCode(() => post(store, clock, "bob", "steal", { message_id: messageId, room_id: threadId, body: { text: "x" } }))).toBe("denied");
		expect(errorCode(() => post(store, clock, "alice", "nowhere", { message_id: messageId, room_id: "404", body: { text: "x" } }))).toBe("invalid_params");

		const moved = post(store, clock, "alice", "move", { message_id: messageId, room_id: threadId, body: { text: "moved" } });
		expect(moved.broadcasts.map((record) => record.method)).toEqual(["message", "reactions"]);
		// A move belongs to both rooms; the re-logged reactions to the destination.
		expect(moved.broadcasts.map((record) => record.rooms)).toEqual([["general", threadId], [threadId]]);
		const snapshot = moved.broadcasts[0].params;
		const reactions = moved.broadcasts[1].params;
		expect(snapshot).toMatchObject({ message_id: messageId, room_id: threadId });
		expect(Number(reactions.log_id)).toBeGreaterThan(Number(snapshot.log_id));
		expect(reactions).toMatchObject({ message_id: messageId, room_id: threadId });
		expect(reactions.reactions).toEqual([
			{ from: { user_id: "alice", name: "Alice" }, emojis: ["👍"] },
			{ from: { user_id: "bob", name: "Bob" }, emojis: ["🎉", "👀"] },
		]);

		// The move belongs to the source and destination logs; earlier history
		// of the message stays in the source room.
		const source = store.historyPage({ roomId: "general", after: "0", limit: 50, now: clock.value });
		expect(messagesOf(source).map((entry) => [entry.log_id, entry.room_id])).toEqual([
			[messageId, "general"],
			[snapshot.log_id, threadId],
		]);
		expect(source.reactions?.map((record) => record.room_id)).toEqual(["general", "general"]);
		const destination = store.historyPage({ roomId: threadId, after: "0", limit: 50, now: clock.value });
		expect(destination.rooms?.map((room) => room.room_id)).toEqual([threadId]);
		expect(messagesOf(destination).map((entry) => entry.log_id)).toEqual([snapshot.log_id]);
		expect(destination.reactions?.map((record) => record.log_id)).toEqual([reactions.log_id]);
		expect(store.getRoomState().latest_log_id).toBe(snapshot.log_id);
		expect(store.getRoomState(threadId).latest_log_id).toBe(reactions.log_id);

		// A later reaction is logged in the message's current room, and a move
		// without reactions logs only the snapshot.
		const later = store.mutate(op(clock, "bob", "react-later", "reactions", { message_id: messageId, emojis: [] }));
		expect(later.broadcasts[0].params.room_id).toBe(threadId);
		const plain = post(store, clock, "bob", "plain", { body: { text: "no reactions" } });
		const plainMove = post(store, clock, "bob", "plain-move", { message_id: plain.result.message_id, room_id: threadId, body: { text: "moved" } });
		expect(plainMove.broadcasts.map((record) => record.method)).toEqual(["message"]);
	});
});

it("sets, clears, collapses, and deduplicates reactions", async () => {
	await withStore("reactions", (store, clock) => {
		const target = post(store, clock, "alice", "target", { body: { text: "react to me" } });
		const messageId = String(target.result.message_id);

		const set = store.mutate(op(clock, "bob", "r1", "reactions", { message_id: messageId, emojis: ["👍", "🎉", "👍"] }));
		expect(set.result).toEqual({});
		expect(set.broadcasts).toEqual([{
			method: "reactions",
			params: {
				log_id: set.broadcasts[0].params.log_id, message_id: messageId, room_id: "general",
				reactions: [{ from: { user_id: "bob", name: "Bob" }, emojis: ["👍", "🎉"] }],
			},
			rooms: ["general"],
		}]);

		const retry = store.mutate(op(clock, "bob", "r1", "reactions", { emojis: ["👍", "🎉", "👍"], message_id: messageId }));
		expect(retry.deduplicated).toBe(true);
		expect(retry.broadcasts).toEqual([]);
		expect(errorCode(() => store.mutate(op(clock, "bob", "r1", "reactions", { message_id: messageId, emojis: [] })))).toBe("invalid_params");

		// A reordered identical set is not a change and produces no record.
		const unchanged = store.mutate(op(clock, "bob", "r2", "reactions", { message_id: messageId, emojis: ["🎉", "👍"] }));
		expect(unchanged.result).toEqual({});
		expect(unchanged.broadcasts).toEqual([]);

		const cleared = store.mutate(op(clock, "bob", "r3", "reactions", { message_id: messageId, emojis: [] }));
		expect(cleared.broadcasts[0].params.reactions).toEqual([{ from: { user_id: "bob", name: "Bob" }, emojis: [] }]);
		expect(store.mutate(op(clock, "bob", "r4", "reactions", { message_id: messageId, emojis: [] })).broadcasts).toEqual([]);

		expect(errorCode(() => store.mutate(op(clock, "bob", "unknown", "reactions", { message_id: "404", emojis: ["👍"] })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "not-array", "reactions", { message_id: messageId, emojis: "👍" })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "not-string", "reactions", { message_id: messageId, emojis: [1] })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "empty", "reactions", { message_id: messageId, emojis: [""] })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "long", "reactions", { message_id: messageId, emojis: ["x".repeat(65)] })))).toBe("invalid_params");
		expect(errorCode(() => store.mutate(op(clock, "bob", "many", "reactions", {
			message_id: messageId, emojis: Array.from({ length: 9 }, (_, index) => `e${index}`),
		})))).toBe("invalid_params");

		const history = store.historyPage({ roomId: "general", after: target.message!.log_id, limit: 50, now: clock.value });
		expect(messagesOf(history).map((entry) => entry.message_id)).toEqual([messageId]);
		expect(history.reactions?.map((record) => record.reactions[0].emojis)).toEqual([["👍", "🎉"], []]);
	});
});

it("rejects new reactions on tombstones and caps reacting users per message", async () => {
	await withStore("reaction-policy", (store, clock) => {
		const target = post(store, clock, "alice", "target", { body: { text: "popular" } });
		const messageId = String(target.result.message_id);
		store.mutate(op(clock, "alice", "a", "reactions", { message_id: messageId, emojis: ["👍"] }));
		store.mutate(op(clock, "bob", "b", "reactions", { message_id: messageId, emojis: ["👍"] }));
		expect(errorCode(() => store.mutate(op(clock, "carol", "c", "reactions", { message_id: messageId, emojis: ["👍"] })))).toBe("invalid_params");
		// Existing reactors may still change their own set.
		expect(store.mutate(op(clock, "bob", "b2", "reactions", { message_id: messageId, emojis: ["🎉"] })).broadcasts).toHaveLength(1);

		post(store, clock, "alice", "delete", { message_id: messageId, deleted: true });
		expect(errorCode(() => store.mutate(op(clock, "bob", "b3", "reactions", { message_id: messageId, emojis: ["👀"] })))).toBe("invalid_params");
		// Clearing a set on a tombstone is still allowed.
		expect(store.mutate(op(clock, "bob", "b4", "reactions", { message_id: messageId, emojis: [] })).broadcasts).toHaveLength(1);
	}, { ...ROOMY, reactionUsersPerMessage: 2 });
});

it("charges reactions and room changes against posting quotas and keeps accepted retries", async () => {
	await withStore("quota", (store, clock) => {
		const target = post(store, clock, "alice", "target", { body: { text: "one" } });
		const reaction = store.mutate(op(clock, "alice", "react", "reactions", { message_id: target.result.message_id, emojis: ["👍"] }));
		expect(reaction.broadcasts).toHaveLength(1);
		const created = store.mutate(op(clock, "alice", "room", "room_set", { parent_room_id: "general", title: "Quota" }));
		const limited = (fn: () => unknown) => {
			try { fn(); expect.unreachable(); }
			catch (error) { expectRetryAfter(error); }
		};
		limited(() => store.mutate(op(clock, "alice", "react-2", "reactions", { message_id: target.result.message_id, emojis: [] })));
		limited(() => store.mutate(op(clock, "alice", "room-2", "room_set", { room_id: created.result.room_id, title: "Renamed" })));
		limited(() => post(store, clock, "alice", "post-2", { body: { text: "two" } }));
		// Accepted retries return their original result without a new charge.
		expect(store.mutate(op(clock, "alice", "room", "room_set", { parent_room_id: "general", title: "Quota" })).result).toEqual(created.result);
		expect(store.mutate(op(clock, "alice", "react", "reactions", { message_id: target.result.message_id, emojis: ["👍"] })).deduplicated).toBe(true);
		clock.value += 61_000;
		expect(store.mutate(op(clock, "alice", "react-3", "reactions", { message_id: target.result.message_id, emojis: [] })).broadcasts).toHaveLength(1);
	}, { anonymousPostsPerMinute: 3 });
});

it("rolls back failed writes atomically while keeping their resource reservation spent", async () => {
	await withStore("rollback", (store, clock, state) => {
		const before = store.getRoomState();
		const budgetBefore = store.budget(clock.value);
		// SQLite itself raises after the transition insert, inside transactionSync.
		// This exercises real rollback rather than substituting a fake database.
		state.storage.sql.exec(`CREATE TRIGGER fail_snapshot BEFORE INSERT ON message_state
			BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END`);
		const attempt = () => post(store, clock, "alice", "retry-after-failed-commit", { body: { text: "atomic message" } });
		expect(attempt).toThrow("injected snapshot failure");
		expect(store.getRoomState().latest_log_id).toBe(before.latest_log_id);
		// Only the seeded general room record exists; nothing from the failed write.
		expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM records").one().n).toBe(1);
		for (const table of ["message_state", "accepted_requests", "principal_limits"]) {
			expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n).toBe(0);
		}
		expect(store.budget(clock.value).writes).toBeGreaterThan(budgetBefore.writes);

		// The failed request was never accepted, so the same request ID commits.
		state.storage.sql.exec("DROP TRIGGER fail_snapshot");
		const committed = attempt();
		expect(committed.deduplicated).not.toBe(true);
		expect(committed.message?.body?.text).toBe("atomic message");
		expect(committed.broadcasts.map((record) => record.method)).toEqual(["message"]);
	});
});

const DEDUP_CONFIG: Partial<StoreConfig> = { anonymousPostsPerMinute: 1 };

it("deduplicates canonical retries before quotas, survives restart, and expires independently", async () => {
	await withStore("dedup", (store, clock, state) => {
		const params = { body: { format: "plain", text: "once", extension: { z: 1, a: 2 } } };
		const first = post(store, clock, "alice", "same", params);
		// A fresh Store over the same native SQLite binding exercises the
		// constructor/restart path without an in-memory fake database.
		const restarted = new Store(state, DEDUP_CONFIG, clock.clock);
		restarted.initialize();
		const retry = post(restarted, clock, "alice", "same", {
			body: { extension: { a: 2, z: 1 }, text: "once", format: "plain" },
		});
		expect(retry.deduplicated).toBe(true);
		expect(retry.broadcasts).toEqual([]);
		expect(retry.result).toEqual(first.result);
		expect(errorCode(() => post(restarted, clock, "alice", "same", { body: { format: "plain", text: "different" } }))).toBe("invalid_params");
		expect(errorCode(() => restarted.mutate(op(clock, "alice", "same", "reactions", params)))).toBe("invalid_params");
		expect(errorCode(() => post(restarted, clock, "alice", "new-request", { body: { format: "plain", text: "blocked" } }))).toBe("retry_after");

		clock.value += RETENTION_MS + 1;
		const afterExpiry = post(restarted, clock, "alice", "same", params);
		expect(afterExpiry.deduplicated).not.toBe(true);
		expect(afterExpiry.result.message_id).not.toBe(first.result.message_id);
	}, DEDUP_CONFIG);
});
