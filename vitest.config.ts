import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
			// Pin the feature switches whatever the plan's defaults. Most suites use
			// guests as convenient posters; test/read-only-guests turns this off to
			// cover guests that only read. Suites that cover typing turn it on.
			// Uploads are on, served from a stand-in media origin. Push is on with a
			// test-only VAPID key pair and a stand-in push service; nothing is pushed
			// unless a test registers a subscription and mentions its user.
			miniflare: {
				bindings: {
					GUEST_POSTING: "true",
					ACTIVITY: "false",
					MEDIA_ORIGIN: "https://media.test",
					PUBLIC_ORIGIN: "https://demo.test",
					UPLOAD_SIGNING_KEY: "test-upload-signing-key-0123456789abcdef",
					VAPID_PUBLIC_KEY: "BDiU8ZnLVhCayOIihLkro6Di0XjZW7iK59umfbY--JzLTzNbhd94tTuBsIzrhXljFDqw5xn8gLqahSsSPDCauDM",
					VAPID_PRIVATE_KEY: "64gdTp6zfZqSbwXmh7xaMx-kTVi4S34yCZxCZ2QT954",
					VAPID_SUBJECT: "mailto:push-test@example.com",
					PUSH_HOSTS: "push.example.net",
					// Wakes push at once; the suites that cover the wait set one.
					PUSH_DELAY_SECONDS: "0",
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
