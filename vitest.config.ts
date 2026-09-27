import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
			// Pin the feature switches whatever the plan's defaults. Most suites use
			// guests as convenient posters; test/read-only-guests turns this off to
			// cover guests that only read. Suites that cover typing turn it on.
			miniflare: { bindings: { GUEST_POSTING: "true", ACTIVITY: "false" } },
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
