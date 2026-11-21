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
		/** The D1 history tier (src/history/d1.ts); without it (or the blob tier), records past SQLite's limits expire at once. */
		HISTORY_D1?: D1Database;
		/** The blob history tier's segments and the backups: a private R2 bucket. */
		HISTORY_BLOB?: R2Bucket;
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
		/** Backups (src/config.ts, RuntimeConfig.backups). */
		BACKUP_EVERY?: string;
		BACKUP_KEEP?: string;
		BACKUP_PRIVATE_ROOMS?: string;
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
			HISTORY_D1?: D1Database;
			HISTORY_BLOB?: R2Bucket;
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
			BACKUP_EVERY?: string;
			BACKUP_KEEP?: string;
			BACKUP_PRIVATE_ROOMS?: string;
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
