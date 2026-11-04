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
		CF_VERSION_METADATA?: WorkerVersionMetadata;
		ACCOUNT_ID?: string;
		ACCOUNT_ANALYTICS_TOKEN?: string;
		ZONE_ID?: string;
		EDGE_STOP_TOKEN?: string;
		MEDIA?: R2Bucket;
		MEDIA_ORIGIN?: string;
		PUBLIC_ORIGIN?: string;
		UPLOAD_SIGNING_KEY?: string;
		VAPID_PUBLIC_KEY?: string;
		VAPID_PRIVATE_KEY?: string;
		VAPID_SUBJECT?: string;
		PUSH_HOSTS?: string;
		PUSH_DELAY_SECONDS?: string;
		OG_MEDIA_HOSTS?: string;
		/** Email sign-in (src/email.ts): the Email Service send binding, the sender address, and where links point; off unless EMAIL and EMAIL_FROM are both set. */
		EMAIL?: SendEmail;
		EMAIL_FROM?: string;
		EMAIL_LINK_URL?: string;
		EMAIL_SERVER?: string;
		ASSETS?: Fetcher;
		ALLOWED_ORIGINS?: string;
		RP_ID?: string;
		RP_ORIGINS?: string;
		RP_NAME?: string;
		SERVER_TITLE?: string;
		SERVER_DESCRIPTION?: string;
		SERVER_AVATAR?: string;
		ADMISSION_OFF?: string;
		ACCOUNTING_RECOVERY?: string;
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
			CF_VERSION_METADATA?: WorkerVersionMetadata;
			ACCOUNT_ID?: string;
			ACCOUNT_ANALYTICS_TOKEN?: string;
			ZONE_ID?: string;
			EDGE_STOP_TOKEN?: string;
			MEDIA?: R2Bucket;
			MEDIA_ORIGIN?: string;
			PUBLIC_ORIGIN?: string;
			UPLOAD_SIGNING_KEY?: string;
			VAPID_PUBLIC_KEY?: string;
			VAPID_PRIVATE_KEY?: string;
			VAPID_SUBJECT?: string;
			PUSH_HOSTS?: string;
			PUSH_DELAY_SECONDS?: string;
			OG_MEDIA_HOSTS?: string;
			/** Email sign-in (src/email.ts): the Email Service send binding, the sender address, and where links point; off unless EMAIL and EMAIL_FROM are both set. */
			EMAIL?: SendEmail;
			EMAIL_FROM?: string;
			EMAIL_LINK_URL?: string;
			EMAIL_SERVER?: string;
			ASSETS?: Fetcher;
			ALLOWED_ORIGINS?: string;
			RP_ID?: string;
			RP_ORIGINS?: string;
			RP_NAME?: string;
			SERVER_TITLE?: string;
			SERVER_DESCRIPTION?: string;
			SERVER_AVATAR?: string;
			ADMISSION_OFF?: string;
			ACCOUNTING_RECOVERY?: string;
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
