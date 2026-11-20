import { describe, expect, it } from 'vitest';
import { MAX_MENTION_BYTES, isEmptyBody, normalizeBody, sharedTextBody } from '../../src/content/body';

const limits = { maxTextBytes: 16, maxEmbeds: 2, ogMediaHosts: [] as string[] };

describe('a message body as kept (§3.5)', () => {
	it.each([
		['fills in an omitted text, format and embeds', {}, { text: '', format: 'plain', embeds: [] }],
		['keeps markdown', { text: '*hi*', format: 'markdown' }, { text: '*hi*', format: 'markdown', embeds: [] }],
		['takes text of exactly maxTextBytes', { text: 'x'.repeat(16) }, { text: 'x'.repeat(16), format: 'plain', embeds: [] }],
		['deduplicates mentions, in order', { text: 'hi', mentions: ['bob', 'ada', 'bob'] }, { text: 'hi', format: 'plain', embeds: [], mentions: ['bob', 'ada'] }],
		['keeps an empty mention list', { text: 'hi', mentions: [] }, { text: 'hi', format: 'plain', embeds: [], mentions: [] }],
		['drops a client\'s output_ref', { embeds: [{ kind: 'terminal', output_ref: { key: 'f/x', bytes: 1 } }] }, { text: '', format: 'plain', embeds: [{ kind: 'terminal' }] }],
		['trims og to its kept fields', { embeds: [{ kind: 'link', og: { title: ' a\nb ', image: { url: 'https://evil.example/x.png' } } }] }, { text: '', format: 'plain', embeds: [{ kind: 'link', og: { title: 'a b' } }] }],
		['keeps unknown body fields', { text: 'hi', extra: { kept: true } }, { text: 'hi', format: 'plain', embeds: [], extra: { kept: true } }],
	])('%s', (_name, body, kept) => {
		expect(normalizeBody(body, limits)).toEqual({ ok: true, value: kept });
	});

	it('never changes the body it was given', () => {
		const body = { text: 'hi', embeds: [{ kind: 'link', output_ref: { key: 'k', bytes: 1 } }] };
		const copy = JSON.parse(JSON.stringify(body));
		normalizeBody(body, limits);
		expect(body).toEqual(copy);
	});

	it.each([
		['a body that is not an object', 'hi', 'invalid_params', 'body must be an object'],
		['an array body', ['hi'], 'invalid_params', 'body must be an object'],
		['non-string text', { text: 5 }, 'invalid_params', 'body.text must be a string'],
		['text past maxTextBytes', { text: 'x'.repeat(17) }, 'too_large', 'body.text is too large'],
		['multibyte text past maxTextBytes', { text: '€'.repeat(6) }, 'too_large', 'body.text is too large'],
		['an unknown format', { text: 'hi', format: 'html' }, 'invalid_params', 'body.format is invalid'],
		['embeds that are not an array', { embeds: {} }, 'invalid_params', 'body.embeds must be an array'],
		['more embeds than maxEmbeds', { embeds: [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }] }, 'denied', 'A message has at most 2 embeds'],
		['an embed that is not an object', { embeds: ['link'] }, 'invalid_params', 'body.embeds must be objects with a kind'],
		['an embed without a kind', { embeds: [{ url: 'https://x.test' }] }, 'invalid_params', 'body.embeds must be objects with a kind'],
		['an embed with an empty kind', { embeds: [{ kind: '' }] }, 'invalid_params', 'body.embeds must be objects with a kind'],
		['mentions that are not an array', { mentions: 'bob' }, 'invalid_params', 'body.mentions must be an array of user_id strings'],
		['a mention that cannot be a user_id', { mentions: ['bob smith'] }, 'invalid_params', 'body.mentions must be an array of user_id strings'],
		['a mention that is not a string', { mentions: [7] }, 'invalid_params', 'body.mentions must be an array of user_id strings'],
		['a mention past MAX_MENTION_BYTES', { mentions: ['x'.repeat(MAX_MENTION_BYTES + 1)] }, 'too_large', 'a mentioned user_id is too long'],
	])('refuses %s', (_name, body, code, message) => {
		expect(normalizeBody(body, limits)).toEqual({ ok: false, code, message });
	});

	it('takes a mention of exactly MAX_MENTION_BYTES', () => {
		expect(normalizeBody({ mentions: ['x'.repeat(MAX_MENTION_BYTES)] }, limits).ok).toBe(true);
	});

	it('knows an empty body: no text and no embeds', () => {
		expect(isEmptyBody({ text: '', embeds: [] })).toBe(true);
		expect(isEmptyBody({ text: ' ', embeds: [] })).toBe(false);
		expect(isEmptyBody({ text: '', embeds: [{ kind: 'upload' }] })).toBe(false);
	});
});

describe('an editor\'s save (ext:editors)', () => {
	it('keeps the current body and takes only the text', () => {
		const current = { text: 'old', format: 'markdown', embeds: [{ kind: 'link' }], mentions: ['bob'] };
		expect(sharedTextBody(current, { text: 'new', format: 'plain', embeds: [], mentions: [] }, limits))
			.toEqual({ ok: true, value: { text: 'new', format: 'markdown', embeds: [{ kind: 'link' }], mentions: ['bob'] } });
		expect(sharedTextBody(undefined, {}, limits)).toEqual({ ok: true, value: { text: '' } });
	});

	it.each([
		['a body that is not an object', null, 'invalid_params', 'body must be an object'],
		['text past maxTextBytes', { text: 'x'.repeat(17) }, 'too_large', 'body.text is too large'],
	])('refuses %s', (_name, body, code, message) => {
		expect(sharedTextBody({ text: 'old' }, body, limits)).toEqual({ ok: false, code, message });
	});
});
