import { describe, expect, it } from 'vitest';
import { hostListAllowed, liveInputLimit, liveResultEmbed, ogLine, terminalOg, uploadResultEmbed, uploadTitle, withCleanOg } from '../../src/content/embeds';

describe('og as plain text (§4.8.1)', () => {
	it.each([
		['keeps a plain line', 'Preview', 10, 'Preview'],
		['folds whitespace and line breaks', ' a\n\tb  c ', 10, 'a b c'],
		['replaces bidi overrides and separators', 'a‮b c⁦d', 10, 'a b c d'],
		['replaces C1 controls', 'a\u0085b', 10, 'a b'],
		['cuts at max code points with an ellipsis', 'abcdefghijkl', 5, 'abcd…'],
		['counts code points, not UTF-16 units', '🐤🐤🐤', 3, '🐤🐤🐤'],
		['trims before the ellipsis', 'abc  defgh', 5, 'abc…'],
	])('%s', (_name, value, max, line) => {
		expect(ogLine(value, max)).toBe(line);
	});

	it.each([[undefined], [5], [' \n '], ['']])('reads %j as no line', (value) => {
		expect(ogLine(value, 10)).toBeUndefined();
	});

	it('keeps title, description and site_name, cut to their lengths, and drops the rest', () => {
		const long = 'x'.repeat(600);
		expect(withCleanOg({ kind: 'link', og: { title: long, description: long, site_name: long, type: 'website', url: 'https://x.test' } }, []))
			.toEqual({ kind: 'link', og: { title: `${'x'.repeat(255)}…`, description: `${'x'.repeat(511)}…`, site_name: `${'x'.repeat(127)}…` } });
	});

	it.each([
		['no og', { kind: 'link' }, { kind: 'link' }],
		['an og that is not an object', { kind: 'link', og: 'text' }, { kind: 'link' }],
		['an og with nothing kept', { kind: 'link', og: { title: ' ', image: { url: 'https://x.test/a.png' } } }, { kind: 'link' }],
	])('leaves no og for %s', (_name, embed, kept) => {
		expect(withCleanOg(embed, [])).toEqual(kept);
	});

	it('titles uploads as og titles are bounded', () => {
		expect(uploadTitle(' notes\n.md ')).toBe('notes .md');
		expect(uploadTitle('x'.repeat(300))).toBe(`${'x'.repeat(255)}…`);
		expect(uploadTitle(42)).toBeUndefined();
	});
});

describe('og media only from the media hosts', () => {
	const hosts = ['i.ytimg.com', '*.cdn.example'];
	const image = (value: unknown) => (withCleanOg({ kind: 'link', og: { title: 'T', image: value } }, hosts).og as Record<string, unknown>).image;

	it('keeps https media on a listed host, with bounded details', () => {
		expect(image({ url: 'https://i.ytimg.com/vi/abc/hq.jpg', type: 'image/png', width: 320, height: -1, alt: 'An\nexample', extra: true }))
			.toEqual({ url: 'https://i.ytimg.com/vi/abc/hq.jpg', type: 'image/png', width: 320, alt: 'An example' });
		expect(image({ url: 'https://x.cdn.example/a.png', type: 'not a type', width: 99_999, height: 1.5 })).toEqual({ url: 'https://x.cdn.example/a.png' });
		// A backslash ends the host: the client loads the same canonical URL the server checked.
		expect(image({ url: 'https://i.ytimg.com\\@evil.example/a.png' })).toEqual({ url: 'https://i.ytimg.com/@evil.example/a.png' });
	});

	it.each([
		['https://evil.example/a.png', 'not listed'],
		['https://cdn.example/a.png', '*.cdn.example is subdomains only'],
		['https://i.ytimg.com.evil.example/a.png', 'a suffix is another host'],
		['https://i.ytimg.com./a.png', 'a trailing dot is another host name'],
		['https://i.ytimg.com%2e/a.png', 'an encoded dot'],
		['https://evil.example\\@i.ytimg.com/a.png', 'credentials before a backslash'],
		['http://i.ytimg.com/a.png', 'https only'],
		['https://user@i.ytimg.com/a.png', 'credentials'],
		['https://i.ytimg.com:8443/a.png', 'a port'],
		['javascript:alert(1)', 'another scheme'],
		['not a url', 'not a URL'],
		[`https://i.ytimg.com/${'a'.repeat(2_100)}`, 'a URL past its byte cap'],
	])('drops %s (%s)', (url) => {
		expect(image({ url })).toBeUndefined();
	});

	it('drops media given as a string, and all media with no hosts', () => {
		expect(image('https://i.ytimg.com/a.png')).toBeUndefined();
		expect(withCleanOg({ kind: 'link', og: { title: 'T', image: { url: 'https://i.ytimg.com/a.png' } } }, [])).toEqual({ kind: 'link', og: { title: 'T' } });
		expect(withCleanOg({ kind: 'link', og: { video: { url: 'https://anywhere.test/v.mp4' } } }, '*')).toEqual({ kind: 'link', og: { video: { url: 'https://anywhere.test/v.mp4' } } });
	});

	it.each([
		[['a.test'], 'a.test', true],
		[['a.test'], 'b.a.test', false],
		[['*.a.test'], 'b.a.test', true],
		[['*.a.test'], 'a.test', false],
		[['*.a.test'], 'b.xa.test', false],
		['*', 'anything.test', true],
		[[], 'a.test', false],
	] as const)('host list %j allows %s: %s', (hosts, host, allowed) => {
		expect(hostListAllowed(hosts, host)).toBe(allowed);
	});
});

describe('embeds the server writes', () => {
	it('lists an upload and a live text with their writes', () => {
		expect(uploadResultEmbed({ key: 'f/k', embedId: 'e1', maxBytes: 10, writeExpiresMs: 5 }))
			.toEqual({ embed_id: 'e1', kind: 'upload', write: { key: 'f/k', max_bytes: 10, expires_ms: 5 } });
		expect(liveResultEmbed({ key: 'l/k', kind: 'terminal', embedId: 'e2', limit: 100, writeExpiresMs: 6 }, { maxInputBytes: 50 }))
			.toEqual({ embed_id: 'e2', kind: 'terminal', write: { key: 'l/k', max_bytes: 50, expires_ms: 6 } });
	});

	it.each([
		['terminal', 100, 50, 50],
		['append', 30, 50, 30],
		['append', 80, 50, 50],
	] as const)('lets a %s with limit %i write at most its bound of %i bytes', (kind, limit, maxInputBytes, bound) => {
		expect(liveInputLimit({ kind, limit }, { maxInputBytes })).toBe(bound);
	});

	it('describes a terminal for clients that do not render it', () => {
		expect(terminalOg('build')).toEqual({ title: 'build', description: 'Terminal output. Open it to watch.' });
		expect(terminalOg('')).toEqual({ title: 'Terminal', description: 'Terminal output. Open it to watch.' });
		expect(terminalOg(undefined).title).toBe('Terminal');
	});
});
