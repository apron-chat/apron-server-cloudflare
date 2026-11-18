import type { ApronDemoServer } from "./src/index";

declare global {
	interface Env {
		DEMO: DurableObjectNamespace<ApronDemoServer>;
		CONNECTION_ATTEMPTS: RateLimit;
		PREFIX_ATTEMPTS: RateLimit;
		LOCATION_ATTEMPTS: RateLimit;
		LIVE_READS?: RateLimit;
		FLOOD_WATCH?: RateLimit;
		/** Workers Analytics Engine dataset for exact counters (src/metrics.ts); optional. */
		METRICS?: AnalyticsEngineDataset;
		/** The dataset METRICS writes, for reading the `active` metric back in /status (src/active-users.ts). */
		METRICS_DATASET?: string;
		CF_VERSION_METADATA?: WorkerVersionMetadata;
		ACCOUNT_ID?: string;
		ACCOUNT_ANALYTICS_TOKEN?: string;
		ZONE_ID?: string;
		EDGE_STOP_TOKEN?: string;
		MEDIA?: R2Bucket;
		/** The history archive (src/archive.ts); without it, records past the hot log's limits expire at once. */
		ARCHIVE?: D1Database;
		MEDIA_ORIGIN?: string;
		MEDIA_NOSNIFF?: string;
		PUBLIC_ORIGIN?: string;
		UPLOAD_SIGNING_KEY?: string;
		VAPID_PUBLIC_KEY?: string;
		VAPID_PRIVATE_KEY?: string;
		VAPID_SUBJECT?: string;
		PUSH_HOSTS?: string;
		PUSH_HOSTS_EXTRA?: string;
		PUSH_DELAY_SECONDS?: string;
		OG_MEDIA_HOSTS?: string;
		OG_MEDIA_HOSTS_EXTRA?: string;
		ASSETS?: Fetcher;
		ALLOWED_ORIGINS?: string;
		RP_ID?: string;
		RP_ORIGINS?: string;
		RP_NAME?: string;
		SERVER_TITLE?: string;
		SERVER_DESCRIPTION?: string;
		SERVER_AVATAR?: string;
		ADMISSION_OFF?: string;
		ATTACK_PAUSE?: string;
		BILL_CAP_DAY?: string;
		BILL_CAP_MONTH?: string;
		LIVE_TEXT?: string;
		TERMINAL_VIEWER_URL?: string;
		ACTIVITY?: string;
		GUEST_POSTING?: string;
		PRESENCE?: string;
		APRON_ADMIN_TOKEN?: string;
		ENVIRONMENT?: string;
		NODE_ENV?: string;
	}
	namespace Cloudflare {
		interface Env {
			DEMO: DurableObjectNamespace<ApronDemoServer>;
			CONNECTION_ATTEMPTS: RateLimit;
			PREFIX_ATTEMPTS: RateLimit;
			LOCATION_ATTEMPTS: RateLimit;
			LIVE_READS?: RateLimit;
			FLOOD_WATCH?: RateLimit;
			/** Workers Analytics Engine dataset for exact counters (src/metrics.ts); optional. */
			METRICS?: AnalyticsEngineDataset;
			/** The dataset METRICS writes, for reading the `active` metric back in /status (src/active-users.ts). */
			METRICS_DATASET?: string;
			CF_VERSION_METADATA?: WorkerVersionMetadata;
			ACCOUNT_ID?: string;
			ACCOUNT_ANALYTICS_TOKEN?: string;
			ZONE_ID?: string;
			EDGE_STOP_TOKEN?: string;
			MEDIA?: R2Bucket;
			ARCHIVE?: D1Database;
			MEDIA_ORIGIN?: string;
			MEDIA_NOSNIFF?: string;
			PUBLIC_ORIGIN?: string;
			UPLOAD_SIGNING_KEY?: string;
			VAPID_PUBLIC_KEY?: string;
			VAPID_PRIVATE_KEY?: string;
			VAPID_SUBJECT?: string;
			PUSH_HOSTS?: string;
			PUSH_HOSTS_EXTRA?: string;
			PUSH_DELAY_SECONDS?: string;
			OG_MEDIA_HOSTS?: string;
			OG_MEDIA_HOSTS_EXTRA?: string;
			ASSETS?: Fetcher;
			ALLOWED_ORIGINS?: string;
			RP_ID?: string;
			RP_ORIGINS?: string;
			RP_NAME?: string;
			SERVER_TITLE?: string;
			SERVER_DESCRIPTION?: string;
			SERVER_AVATAR?: string;
			ADMISSION_OFF?: string;
			ATTACK_PAUSE?: string;
			BILL_CAP_DAY?: string;
			BILL_CAP_MONTH?: string;
			LIVE_TEXT?: string;
			TERMINAL_VIEWER_URL?: string;
			ACTIVITY?: string;
			GUEST_POSTING?: string;
			PRESENCE?: string;
			APRON_ADMIN_TOKEN?: string;
			ENVIRONMENT?: string;
			NODE_ENV?: string;
		}
	}
}

export {};
