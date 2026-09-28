// Announces a merged pull request in an Apron room as a bot, with a link
// preview (`og`) built from the pull request itself. Run by the Announce
// workflow on `pull_request_target` `closed`; reads the event from
// GITHUB_EVENT_PATH and the bot token from APRON_BOT_TOKEN, and does nothing
// when that is unset.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'wss://server.apron.chat/';
const DEFAULT_ROOM = 'general';
const TIMEOUT_MS = 30_000;
const DESCRIPTION_CODE_POINTS = 300;

/** `text` as one line of at most `max` code points, or '' when empty. */
export function oneLine(text, max) {
	const line = String(text ?? '')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const points = [...line];
	return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : line;
}

/** The first paragraph of markdown `text` that is not only headings, or ''. */
export function firstParagraph(text) {
	const paragraphs = String(text ?? '').replace(/<!--[\s\S]*?-->/g, ' ').split(/\n\s*\n/);
	for (const paragraph of paragraphs) {
		const lines = paragraph.split('\n').filter((line) => !/^\s{0,3}#{1,6}(\s|$)/.test(line));
		const kept = lines.join('\n').trim();
		if (kept) return kept;
	}
	return '';
}

/** The `message` params announcing merged pull request `pr` of `repo` (`owner/name`) in `roomId`. */
export function announcement(pr, repo, roomId = DEFAULT_ROOM) {
	const author = pr.user?.login ?? 'someone';
	const base = pr.base?.ref ?? 'main';
	const summary = `#${pr.number} by ${author} · ${pr.commits ?? 0} commit${pr.commits === 1 ? '' : 's'} · +${pr.additions ?? 0} −${pr.deletions ?? 0}`;
	const description = oneLine(firstParagraph(pr.body), DESCRIPTION_CODE_POINTS) || summary;
	return {
		room_id: roomId,
		body: {
			text: `Merged into ${base}: ${oneLine(pr.title, 256)} (${repo}#${pr.number} by ${author})\n${pr.html_url}`,
			format: 'plain',
			embeds: [{
				kind: 'link',
				url: pr.html_url,
				og: {
					site_name: `GitHub · ${repo}`,
					title: `${oneLine(pr.title, 240)} · Pull Request #${pr.number}`,
					description,
					// Kept only where the server allows remote og media.
					image: { url: `https://opengraph.githubassets.com/${pr.merge_commit_sha ?? '1'}/${repo}/pull/${pr.number}`, width: 1200, height: 600 },
				},
			}],
		},
	};
}

/**
 * Connects to `url`, signs in with bot `token`, and posts `params`. Resolves
 * with the message result; rejects on a protocol error, close, or timeout.
 * The request ID is stable per pull request, so a rerun of the same job
 * within the server's deduplication window does not post twice.
 */
export function post(url, token, params, requestId) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		let done = false;
		const finish = (error, value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.close();
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(() => finish(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
		socket.onerror = (event) => finish(new Error(`WebSocket error: ${event.message ?? 'connection failed'}`));
		socket.onclose = ({ code, reason }) => finish(new Error(`connection closed (${code}${reason ? `: ${reason}` : ''})`));
		socket.onmessage = ({ data }) => {
			let frame;
			try {
				frame = JSON.parse(data);
			} catch {
				return;
			}
			if (frame.method === 'server') {
				socket.send(JSON.stringify({ id: 'auth', method: 'auth', params: { scheme: 'token', token } }));
				socket.send(JSON.stringify({ id: requestId, method: 'message', params }));
			} else if (frame.id === 'auth' && frame.error) {
				finish(new Error(`auth failed: ${frame.error.message}`));
			} else if (frame.id === requestId) {
				if (frame.error) finish(new Error(`message failed: ${frame.error.message}`));
				else finish(null, frame.result);
			}
		};
	});
}

async function main() {
	const token = process.env.APRON_BOT_TOKEN;
	if (!token) {
		// Announcing is opt-in: forks and repositories without the secret skip it.
		console.log('::notice::APRON_BOT_TOKEN is not set; skipping the announcement.');
		return;
	}
	const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
	const pr = event.pull_request;
	if (!pr?.merged) {
		console.log('Pull request was not merged; nothing to announce.');
		return;
	}
	const repo = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
	const url = process.env.APRON_URL || DEFAULT_URL;
	const params = announcement(pr, repo, process.env.APRON_ROOM || DEFAULT_ROOM);
	const result = await post(url, token, params, `announce-pr-${repo}-${pr.number}`);
	console.log(`Announced ${repo}#${pr.number} in ${params.room_id} on ${url}: ${JSON.stringify(result)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
