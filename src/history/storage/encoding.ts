/*
 * How archives are stored: the codec chain (@apron/archive codecs) an
 * archive goes through on its way to a BlobStore, recorded with it so that
 * a reader knows how to read it back. Callers hand a chain over and never
 * look inside it: whatever its codecs do to the bytes is theirs. The chain
 * this server stores everything through is named once, in history/config.ts
 * (HISTORY_CODECS).
 */

import { type ArchiveCodec, ARCHIVE_CODECS, codecChain, codecNames, codecsFromName, parseCodecNames } from "@apron/archive";
import type { BlobObject, BlobPutOptions } from "./store";

/** The metadata key a stored archive's codec chain is recorded under (codec names, comma-separated, in encoding order). */
export const CODECS_METADATA = "codecs";

/** How an archive encoded through `chain` is stored: its content type, and the chain's names in its metadata. */
export function storedOptions(chain: readonly ArchiveCodec[]): BlobPutOptions {
	return chain.length
		? { contentType: "application/octet-stream", metadata: { [CODECS_METADATA]: codecNames(chain) } }
		: { contentType: "application/jsonl" };
}

/**
 * The chain a stored archive went through: as its metadata records it,
 * else as its name says (`.jsonl` and each codec's extension), else none.
 * A codec the registry lacks is refused, never skipped.
 */
export function storedChain(key: string, object: Pick<BlobObject, "metadata">, registry: Readonly<Record<string, ArchiveCodec>> = ARCHIVE_CODECS): ArchiveCodec[] {
	const recorded = object.metadata?.[CODECS_METADATA];
	return recorded !== undefined ? codecChain(parseCodecNames(recorded), registry) : codecsFromName(key, registry) ?? [];
}
