import { describe, expect, it } from 'vitest';
import { cleanName } from '../../src/content/user';

describe('cleanName', () => {
	it('drops controls, format characters, private use and lone surrogates', () => {
		expect(cleanName('Ada\u0000\u0007\u001b[31m Lovelace\u007f')).toBe('Ada[31m Lovelace');
		// A right-to-left override and an isolate, which could reverse the text around them.
		expect(cleanName('\u202Egnp.exe\u202C Bob\u2066x\u2069')).toBe('gnp.exe Bobx');
		// Zero-width space, joiner and non-joiner, and a byte order mark.
		expect(cleanName('Z\u200Bo\u200Ce\u200D\uFEFF')).toBe('Zoe');
		// A ZWJ emoji sequence falls apart into its parts, as on the Go server.
		expect(cleanName('Fam 👨\u200D👩\u200D👧')).toBe('Fam 👨👩👧');
		expect(cleanName('Priv\uE000ate \uDC00x')).toBe('Private x');
	});

	it('maps compatibility characters (NFKC), folds runs of spaces, and trims', () => {
		expect(cleanName('\uFF26\uFF55\uFF4C\uFF4C\u3000\uFF57\uFF49\uFF44\uFF54\uFF48')).toBe('Full width');
		expect(cleanName('\uFB01ne \u2460')).toBe('fine 1');
		expect(cleanName('  many \u00A0  \u2003 spaces  here  ')).toBe('many spaces here');
		// Tabs and line breaks are controls: dropped, as on the Go server, not made spaces.
		expect(cleanName('two\tparts\nhere')).toBe('twopartshere');
		expect(cleanName('Café')).toBe('Café');
	});

	it('leaves nothing of a name made only of what it drops, or with an unassigned code point', () => {
		expect(cleanName('\u200B\u202E \u0000 ')).toBe('');
		expect(cleanName('a\u0378b')).toBe('');
		expect(cleanName('Ordinary name')).toBe('Ordinary name');
	});
});
