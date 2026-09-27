import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
			// Pin the feature switches whatever the plan's defaults. Most suites use
			// guests as convenient posters; test/read-only-guests turns this off to
			// cover guests that only read. Suites that cover typing turn it on.
			// Uploads are on, served from a stand-in media origin.
			miniflare: {
				bindings: {
					GUEST_POSTING: "true",
					ACTIVITY: "false",
					MEDIA_ORIGIN: "https://media.test",
					PUBLIC_ORIGIN: "https://demo.test",
					UPLOAD_SIGNING_KEY: "test-upload-signing-key-0123456789abcdef",
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
