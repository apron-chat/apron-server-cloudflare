import { describe, expect, it } from 'vitest';
import { AUDIO_TYPES, sniffAudio } from '../../src/content/media/audio';
import { IMAGE_TYPES, sniffImage } from '../../src/content/media/image';
import { TEXT_CONTENT_TYPE, TEXT_TYPES, sniffText } from '../../src/content/media/text';

/** A PNG header of the given size: all the sniffer reads. */
function png(width = 1, height = 1, bytes = 64): Uint8Array {
	const data = new Uint8Array(bytes);
	data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(data.buffer).setUint32(16, width);
	new DataView(data.buffer).setUint32(20, height);
	return data;
}

/** A WebM header as MediaRecorder writes it: EBML with DocType "webm". */
function webm(bytes = 64): Uint8Array {
	const data = new Uint8Array(bytes);
	data.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...new TextEncoder().encode('webm')]);
	return data;
}

describe('upload types come from the bytes, never from the sender', () => {
	it('knows images by their bytes, with sizes where the header has them', () => {
		expect(sniffImage(png(640, 480))).toEqual({ type: 'image/png', width: 640, height: 480 });
		const gif = new Uint8Array([...new TextEncoder().encode('GIF89a'), 0x20, 0x00, 0x10, 0x00]);
		expect(sniffImage(gif)).toEqual({ type: 'image/gif', width: 32, height: 16 });
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03]);
		expect(sniffImage(jpeg)).toEqual({ type: 'image/jpeg', width: 64, height: 48 });
		const webp = new Uint8Array(30);
		webp.set(new TextEncoder().encode('RIFF'), 0);
		webp.set(new TextEncoder().encode('WEBPVP8X'), 8);
		webp.set([99, 0, 0, 49, 0, 0], 24);
		expect(sniffImage(webp)).toEqual({ type: 'image/webp', width: 100, height: 50 });
		expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
		expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
		expect(sniffImage(webm())).toBeNull();
	});

	it('knows voice clips by their containers: WebM, Ogg, and MP4', () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		expect(sniffAudio(webm())).toEqual({ type: 'audio/webm' });
		const matroska = webm();
		matroska.set(encode('mkv '), 12);
		expect(sniffAudio(matroska)).toBeNull();
		const ogg = (codec: string) => {
			const data = new Uint8Array(64);
			data.set(encode('OggS'), 0);
			data[26] = 1;
			data[27] = 19;
			data.set(encode(codec), 28);
			return data;
		};
		expect(sniffAudio(ogg('OpusHead'))).toEqual({ type: 'audio/ogg' });
		expect(sniffAudio(ogg('\x01vorbis'))).toEqual({ type: 'audio/ogg' });
		expect(sniffAudio(ogg('\x80theora'))).toBeNull();
		const mp4 = (brand: string) => new Uint8Array([0, 0, 0, 24, ...encode('ftyp'), ...encode(brand), 0, 0, 0, 0]);
		expect(sniffAudio(mp4('iso5'))).toEqual({ type: 'audio/mp4' });
		expect(sniffAudio(mp4('M4A '))).toEqual({ type: 'audio/mp4' });
		expect(sniffAudio(mp4('heic'))).toBeNull();
		expect(sniffAudio(mp4('avif'))).toBeNull();
		expect(sniffAudio(png())).toBeNull();
		expect(sniffAudio(encode('<html><script>alert(1)</script>'))).toBeNull();
	});

	it('keeps any UTF-8 text without a NUL byte as Markdown', () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		expect(sniffText(encode('# Plan\n\n- canary 🐤'))).toEqual({ type: 'text/markdown' });
		// It is served as Markdown, which no browser runs, whatever it holds.
		expect(sniffText(encode('<html><script>alert(1)</script>'))).toEqual({ type: 'text/markdown' });
		expect(sniffText(new Uint8Array())).toBeNull();
		expect(sniffText(encode('a\0b'))).toBeNull();
		expect(sniffText(new Uint8Array([0x23, 0x20, 0xff, 0xfe]))).toBeNull();
		expect(sniffText(png())).toBeNull();
		expect(sniffText(webm())).toBeNull();
	});

	it('names only types its sniffers return, and serves text as Markdown', () => {
		expect(IMAGE_TYPES).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
		expect(AUDIO_TYPES).toEqual(['audio/webm', 'audio/ogg', 'audio/mp4']);
		expect(TEXT_TYPES).toEqual(['text/markdown']);
		expect(TEXT_CONTENT_TYPE).toBe('text/markdown; charset=utf-8');
		// A header cut short is no image.
		expect(sniffImage(png().slice(0, 12))).toBeNull();
		expect(sniffImage(new Uint8Array())).toBeNull();
		expect(sniffAudio(new Uint8Array())).toBeNull();
	});
});
