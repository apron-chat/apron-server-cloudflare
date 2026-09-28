import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcement, firstParagraph, oneLine } from './announce-pr.mjs';

const pr = {
	number: 12,
	title: 'Announce merged\npull requests',
	html_url: 'https://github.com/apron-chat/apron-server-cloudflare/pull/12',
	body: '<!-- template -->\nPosts each merged PR\nto the `general` room.\n\n## Details\nMore.',
	user: { login: 'shazow' },
	base: { ref: 'main' },
	merge_commit_sha: 'abc123',
	commits: 1,
	additions: 10,
	deletions: 2,
	merged: true,
};

test('announces a merged pull request with a link preview', () => {
	const params = announcement(pr, 'apron-chat/apron-server-cloudflare');
	assert.equal(params.room_id, 'general');
	assert.equal(params.body.format, 'plain');
	assert.equal(params.body.text, `Merged into main: Announce merged pull requests (apron-chat/apron-server-cloudflare#12 by shazow)\n${pr.html_url}`);
	assert.deepEqual(params.body.embeds, [{
		kind: 'link',
		url: pr.html_url,
		og: {
			site_name: 'GitHub · apron-chat/apron-server-cloudflare',
			title: 'Announce merged pull requests · Pull Request #12',
			description: 'Posts each merged PR to the `general` room.',
			image: { url: 'https://opengraph.githubassets.com/abc123/apron-chat/apron-server-cloudflare/pull/12', width: 1200, height: 600 },
		},
	}]);
});

test('falls back to a summary without a body and honors the room', () => {
	const params = announcement({ ...pr, body: null }, 'o/r', 'thread');
	assert.equal(params.room_id, 'thread');
	assert.equal(params.body.embeds[0].og.description, '#12 by shazow · 1 commit · +10 −2');
});

test('clips long text to one bounded line', () => {
	assert.equal(oneLine('a\n\tb  c', 10), 'a b c');
	assert.equal(oneLine('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
	assert.equal(oneLine(undefined, 10), '');
});

test('describes a pull request by its first paragraph of text', () => {
	assert.equal(firstParagraph('Intro line\nwraps here.\n\n## Summary\nMore.'), 'Intro line\nwraps here.');
	assert.equal(firstParagraph('<!-- note -->\n\n## Summary\nFirst text.\n\nLater.'), 'First text.');
	assert.equal(firstParagraph('# Title\n\n###\n\n  \n'), '');
	assert.equal(firstParagraph('#hashtag start\n\nnext'), '#hashtag start');
	assert.equal(oneLine(firstParagraph('## Summary\r\nFirst\r\nline.\r\n\r\nLater.'), 300), 'First line.');
	assert.equal(firstParagraph(null), '');
});
