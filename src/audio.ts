// Voice clips attach to messages beside images (never as avatars): WebM and
// Ogg from Chrome's and Firefox's MediaRecorder, MP4 from Safari's. As with
// images, the type comes from the bytes, never from the sender. Only the
// container is checked, so a WebM or MP4 holding video is kept too; it is
// served as audio, within the same size and count limits as an image.

interface AudioInfo {
	type: "audio/webm" | "audio/ogg" | "audio/mp4";
}

/** ISO base media brands that are images (HEIF, AVIF), not audio. */
const IMAGE_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"]);

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		if (bytes[start + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}

/** The audio a body holds, from its container's signature, or null for anything else. */
export function sniffAudio(bytes: Uint8Array): AudioInfo | null {
	// EBML with DocType "webm" (element 0x4282, size 4) in its header.
	if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
		const end = Math.min(bytes.length, 64) - 7;
		for (let offset = 4; offset <= end; offset += 1) {
			if (bytes[offset] === 0x42 && bytes[offset + 1] === 0x82 && bytes[offset + 2] === 0x84 && ascii(bytes, offset + 3, "webm")) return { type: "audio/webm" };
		}
		return null;
	}
	// The first Ogg page starts a stream; its first packet names the codec.
	if (bytes.length >= 28 && ascii(bytes, 0, "OggS")) {
		const packet = 27 + bytes[26];
		if (ascii(bytes, packet, "OpusHead") || ascii(bytes, packet, "\x01vorbis") || ascii(bytes, packet, "\x7fFLAC")) return { type: "audio/ogg" };
		return null;
	}
	if (bytes.length >= 12 && ascii(bytes, 4, "ftyp")) {
		const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
		return IMAGE_BRANDS.has(brand) ? null : { type: "audio/mp4" };
	}
	return null;
}
