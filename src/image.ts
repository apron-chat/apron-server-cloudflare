// Uploads are images only: the type comes from the bytes, never from the
// sender, so the public bucket serves nothing a browser would run as a
// document. Dimensions go in `og.image` when the header gives them cheaply.

interface ImageInfo {
	type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	width?: number;
	height?: number;
}

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		if (bytes[start + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}

function sized(type: ImageInfo["type"], width: number, height: number): ImageInfo {
	return width > 0 && height > 0 ? { type, width, height } : { type };
}

/** The image a body holds, from its signature, or null for anything else. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length >= 24 && ascii(bytes, 0, "\x89PNG\r\n\x1a\n") && ascii(bytes, 12, "IHDR")) {
		return sized("image/png", view.getUint32(16), view.getUint32(20));
	}
	if (bytes.length >= 10 && (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) {
		return sized("image/gif", view.getUint16(6, true), view.getUint16(8, true));
	}
	if (bytes.length >= 16 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
		if (bytes.length >= 30 && ascii(bytes, 12, "VP8X")) {
			return sized("image/webp", 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)));
		}
		if (bytes.length >= 30 && ascii(bytes, 12, "VP8 ")) {
			return sized("image/webp", view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
		}
		if (bytes.length >= 25 && ascii(bytes, 12, "VP8L")) {
			const bits = view.getUint32(21, true);
			return sized("image/webp", (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
		}
		return { type: "image/webp" };
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		// Walk the segments to the first start-of-frame, which holds the size.
		let offset = 2;
		while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
			const marker = bytes[offset + 1];
			const length = view.getUint16(offset + 2);
			const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (startOfFrame) return sized("image/jpeg", view.getUint16(offset + 7), view.getUint16(offset + 5));
			if (length < 2) break;
			offset += 2 + length;
		}
		return { type: "image/jpeg" };
	}
	return null;
}
