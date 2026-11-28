import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { basename, delimiter, dirname } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The archives `npm run roundtrip` names (scripts/roundtrip.mjs), read here
 * since the Workers pool cannot read the host's files: ROUNDTRIP_SCENES, a
 * JSON object of name → text (a scene's name is its directory's, as in
 * scene.apron.chat's scenes/<name>/scene.jsonl), and ROUNDTRIP_ONLY to leave
 * the fixtures out.
 */
function roundtripScenes(): Record<string, string> {
	const paths = (process.env.ROUNDTRIP_SCENES ?? "").split(delimiter).filter(Boolean);
	if (!paths.length) return process.env.ROUNDTRIP_ONLY ? { ROUNDTRIP_ONLY: "true" } : {};
	const scenes: Record<string, string> = {};
	for (const path of paths) {
		const base = basename(path) === "scene.jsonl" ? basename(dirname(path)) : basename(path).replace(/\.jsonl$/, "");
		let name = base;
		for (let index = 2; name in scenes; index += 1) name = `${base}-${index}`;
		scenes[name] = readFileSync(path, "utf8");
	}
	return { ROUNDTRIP_SCENES: JSON.stringify(scenes), ...(process.env.ROUNDTRIP_ONLY ? { ROUNDTRIP_ONLY: "true" } : {}) };
}

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
			// Pin the feature switches whatever the plan's defaults. Most suites use
			// guests as convenient posters; test/read-only-guests turns this off to
			// cover guests that only read. Suites that cover typing turn it on.
			// Uploads are on, served from a stand-in media origin, and so is live text. Push is on with a
			// test-only VAPID key pair and a stand-in push service; nothing is pushed
			// unless a test registers a subscription and mentions its user.
			miniflare: {
				// Every suite's sockets reach the Worker from one location, so the
				// shared location limit would couple unrelated tests. Raise it here;
				// test/admission.integration.test.ts covers it with a stand-in.
				ratelimits: {
					LOCATION_ATTEMPTS: { namespace_id: "73007", simple: { limit: 1_000_000, period: 60 } },
					LIVE_READS: { namespace_id: "73009", simple: { limit: 1_000_000, period: 60 } },
				},
				bindings: {
					GUEST_POSTING: "true",
					// Off by default (src/config.ts); on here, to exercise the passkey page's signal.
					SIGNAL_UNKNOWN_PASSKEYS: "true",
					ACTIVITY: "false",
					MEDIA_ORIGIN: "https://media.test",
					// As if the media host's apron_media_nosniff rule were on: attachments may be text.
					MEDIA_NOSNIFF: "true",
					PUBLIC_ORIGIN: "https://demo.test",
					UPLOAD_SIGNING_KEY: "test-upload-signing-key-0123456789abcdef",
					VAPID_PUBLIC_KEY: "BDiU8ZnLVhCayOIihLkro6Di0XjZW7iK59umfbY--JzLTzNbhd94tTuBsIzrhXljFDqw5xn8gLqahSsSPDCauDM",
					VAPID_PRIVATE_KEY: "64gdTp6zfZqSbwXmh7xaMx-kTVi4S34yCZxCZ2QT954",
					VAPID_SUBJECT: "mailto:push-test@example.com",
					PUSH_HOSTS: "push.example.net",
					// Wakes push at once; the suites that cover the wait set one.
					PUSH_DELAY_SECONDS: "0",
					// Push kind `webhook` (a test-only Ed25519 seed): nothing is called unless a test registers a bot's webhook.
					WEBHOOK_SIGNING_KEY: "whsk_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
					// Live text (on with PUBLIC_ORIGIN and UPLOAD_SIGNING_KEY) with tiny
					// time limits, so test/live-text.integration.test.ts sees them end.
					LIVE_TEXT_MAX_SECONDS: "2",
					LIVE_TEXT_MODERATOR_MAX_SECONDS: "3",
					LIVE_TEXT_WRITE_WINDOW_SECONDS: "3",
					// The property tests' replay and soak switches (test/history/chain.test.ts),
					// from the shell: HISTORY_SEED=… HISTORY_PATH=… or HISTORY_RUNS=… npx vitest run.
					...Object.fromEntries(["HISTORY_SEED", "HISTORY_PATH", "HISTORY_RUNS"].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))),
					// The scene round trip's extra archives (scripts/roundtrip.mjs).
					...roundtripScenes(),
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
	},
});
