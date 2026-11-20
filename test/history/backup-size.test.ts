// What an import can take, said on both sides: a backup's decoded size is
// counted as it is written (BackupResult.decodedBytes), an export past what
// an import reads says so, and an import past it is refused naming the limit.
import { describe, expect, it } from "vitest";
import { writeArchiveToString } from "@apron/archive";
import { BackupStore, MAX_IMPORT_BYTES, importableWarning } from "../../src/history/exports";
import { HISTORY_CODECS } from "../../src/history/config";
import { MemoryBlobStore } from "./support/memory-blob-store";

const header = { apron_archive: 1 as const, server: "wss://size.test/" };
const records = (count: number) => Array.from({ length: count }, (_, index) => ({
	room_id: "lobby", log_id: 1_000 + index, commit_ms: 1_000 + index, kind: "message" as const,
	record_json: JSON.stringify({ message_id: `m${index}`, log_id: String(1_000 + index), room_id: "lobby", from: { user_id: "ada" }, body: { text: "x".repeat(200), format: "plain", embeds: [] } }),
}));

describe("backup size", () => {
	it("counts a backup's decoded size as it is written", async () => {
		const backups = new BackupStore(new MemoryBlobStore(), HISTORY_CODECS);
		const fill = async (archive: Parameters<Parameters<BackupStore["write"]>[1]>[0]) => {
			await archive.header(header);
			await archive.listing({ not_joined: [{ room_id: "lobby" }] });
			await archive.records(records(300));
			await archive.close();
			return "done";
		};
		const { value, decodedBytes } = await backups.write("backups/size.jsonl.gz", fill);
		expect(value).toBe("done");
		const plain = await writeArchiveToString(async (archive) => {
			await archive.header(header);
			await archive.listing({ not_joined: [{ room_id: "lobby" }] });
			await archive.records(records(300));
		});
		expect(decodedBytes).toBe(new TextEncoder().encode(plain).length);
	});

	it("refuses to import past the limit, naming it, decoded as well as stored", async () => {
		const backups = new BackupStore(new MemoryBlobStore(), HISTORY_CODECS);
		const { decodedBytes } = await backups.write("backups/big.jsonl.gz", async (archive) => {
			await archive.header(header);
			await archive.records(records(2_000));
			await archive.close();
		});
		// Gzip shrinks it far below what it decodes to: the decoded bound refuses it.
		await expect(backups.open("backups/big.jsonl.gz", Math.floor(decodedBytes / 2))).rejects.toThrow(String(Math.floor(decodedBytes / 2)));
		expect((await backups.open("backups/big.jsonl.gz", decodedBytes + 1))?.archive.records).toHaveLength(2_000);
	});

	it("warns of a backup past what an import reads, and says nothing below it", () => {
		expect(MAX_IMPORT_BYTES).toBe(16 * 1024 * 1024);
		expect(importableWarning(MAX_IMPORT_BYTES)).toBe("");
		expect(importableWarning(MAX_IMPORT_BYTES + 1)).toMatch(/more than the 16\.0 MiB `\/history import` reads/);
	});
});
