// Text attachments beside images and voice clips (never as avatars or
// emoji): Markdown, as a client's "Embed as attachment" sends a long draft.
// Bytes can't tell Markdown from any other text, so any UTF-8 text without
// a NUL byte is kept as Markdown, served as `text/markdown; charset=utf-8`.
// Opened as a page, browsers show or download that, never run it. But a
// page can load any URL with `<script src>`, and without
// `X-Content-Type-Options: nosniff` a browser runs a text that parses as
// JavaScript (it refuses only image, audio, video and CSV types). So text is
// kept only where the media origin sends nosniff (`textFiles`,
// src/config.ts: MEDIA_NOSNIFF and the apron_media_nosniff edge rule).

/** The text types sniffText recognizes, and so the only ones kept. */
export const TEXT_TYPES = ["text/markdown"] as const;

interface TextInfo {
	type: typeof TEXT_TYPES[number];
}

/** What a text attachment is stored as, so it reads as UTF-8 wherever it is opened. */
export const TEXT_CONTENT_TYPE = "text/markdown; charset=utf-8";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Text, as UTF-8 without a NUL byte, or null for anything else (an image, audio, any other binary). */
export function sniffText(bytes: Uint8Array): TextInfo | null {
	if (bytes.length === 0 || bytes.includes(0)) return null;
	try {
		utf8.decode(bytes);
	} catch {
		return null;
	}
	return { type: "text/markdown" };
}
