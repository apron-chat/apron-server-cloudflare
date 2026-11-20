import { describe, expect, it } from 'vitest';
import { MAX_EMOJI_BYTES, emojiIdentity, isEmojiKey, normalizeEmojis, qualifyEmoji } from '../../src/content/emoji';

describe('reaction entries (§4.7)', () => {
	it('stores emoji sequences fully qualified', () => {
		// Text-default emoji take U+FE0F.
		expect(qualifyEmoji('❤')).toBe('❤️');
		expect(qualifyEmoji('☺')).toBe('☺️');
		// Keycaps take it before the combining keycap.
		expect(qualifyEmoji('#⃣')).toBe('#️⃣');
		// Each part of a ZWJ sequence that needs it.
		expect(qualifyEmoji('\u{1F3F3}‍\u{1F308}')).toBe('\u{1F3F3}️‍\u{1F308}');
		expect(qualifyEmoji('\u{1F441}‍\u{1F5E8}')).toBe('\u{1F441}️‍\u{1F5E8}️');
		expect(qualifyEmoji('❤‍\u{1F525}')).toBe('❤️‍\u{1F525}');
		// Already qualified, emoji-default, skin tones, and families stay as they are.
		for (const entry of ['❤️', '👍', '👍🏽', '🏳️‍🌈', '👨‍👩‍👧', '☝🏽']) expect(qualifyEmoji(entry)).toBe(entry);
		// What is not an RGI emoji is kept as written.
		for (const entry of ['x', 'hello', '👍👍', ':party:']) expect(qualifyEmoji(entry)).toBe(entry);
	});

	it('compares entries without U+FE0F', () => {
		expect(emojiIdentity('❤️')).toBe(emojiIdentity('❤'));
		expect(emojiIdentity('🏳️‍🌈')).toBe('\u{1F3F3}‍\u{1F308}');
	});

	it('tells custom emoji keys from emoji sequences (ext:emoji)', () => {
		for (const key of [':partyparrot:', ':+1:', ':a_b-c:', ':Ship_It:']) expect(isEmojiKey(key)).toBe(true);
		for (const entry of ['👍', 'partyparrot', ':party parrot:', '::', ':party', ':pärty:', ':a::b:']) expect(isEmojiKey(entry)).toBe(false);
	});
});

describe('a reaction set as kept (§4.7)', () => {
	const limits = { reactionEmojisPerUser: 3 };

	it.each([
		['qualifies sequences and keeps custom keys as written', ['❤', ':party:', '👍'], ['❤️', ':party:', '👍']],
		['collapses duplicates, entries differing only in U+FE0F too', ['👍', '❤', '❤️', '👍'], ['👍', '❤️']],
		['keeps the first spelling of a duplicate', ['❤️', '❤'], ['❤️']],
		['takes an empty set: the user clears theirs', [], []],
		['counts entries after collapsing', ['👍', '👍', '👍', '👍', '❤', '🎉'], ['👍', '❤️', '🎉']],
		['takes an entry of exactly MAX_EMOJI_BYTES', ['a'.repeat(MAX_EMOJI_BYTES)], ['a'.repeat(MAX_EMOJI_BYTES)]],
	])('%s', (_name, emojis, kept) => {
		expect(normalizeEmojis(emojis, limits)).toEqual({ ok: true, value: kept });
	});

	it.each([
		['not an array', '👍', 'invalid_params', 'emojis must be an array'],
		['a non-string entry', ['👍', 1], 'invalid_params', 'each emoji must be a non-empty string'],
		['an empty entry', [''], 'invalid_params', 'each emoji must be a non-empty string'],
		['an entry over MAX_EMOJI_BYTES', ['a'.repeat(MAX_EMOJI_BYTES + 1)], 'too_large', 'emoji is too long'],
		['a control character', ['👍\n'], 'invalid_params', 'emoji is not a single sequence'],
		['DEL', ['\u007f'], 'invalid_params', 'emoji is not a single sequence'],
		['more entries than the cap', ['👍', '❤', '🎉', '🚀'], 'denied', 'A reaction set holds at most 3 emoji'],
	])('refuses %s', (_name, emojis, code, message) => {
		expect(normalizeEmojis(emojis, limits)).toEqual({ ok: false, code, message });
	});
});
