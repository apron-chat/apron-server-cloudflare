import type { ApronDemoServer } from "./src/index";

declare global {
	interface Env {
		DEMO: DurableObjectNamespace<ApronDemoServer>;
		CONNECTION_ATTEMPTS: RateLimit;
		FLOOD_WATCH?: RateLimit;
		CF_VERSION_METADATA?: WorkerVersionMetadata;
		ACCOUNT_ID?: string;
		ACCOUNT_ANALYTICS_TOKEN?: string;
		ZONE_ID?: string;
		EDGE_STOP_TOKEN?: string;
		MEDIA?: R2Bucket;
		MEDIA_ORIGIN?: string;
		PUBLIC_ORIGIN?: string;
		UPLOAD_SIGNING_KEY?: string;
		ASSETS?: Fetcher;
		ALLOWED_ORIGINS?: string;
		RP_ID?: string;
		RP_ORIGINS?: string;
		RP_NAME?: string;
		ADMISSION_OFF?: string;
		ENVIRONMENT?: string;
	}
	namespace Cloudflare {
		interface Env {
			DEMO: DurableObjectNamespace<ApronDemoServer>;
			CONNECTION_ATTEMPTS: RateLimit;
			FLOOD_WATCH?: RateLimit;
			CF_VERSION_METADATA?: WorkerVersionMetadata;
			ACCOUNT_ID?: string;
			ACCOUNT_ANALYTICS_TOKEN?: string;
			ZONE_ID?: string;
			EDGE_STOP_TOKEN?: string;
			MEDIA?: R2Bucket;
			MEDIA_ORIGIN?: string;
			PUBLIC_ORIGIN?: string;
			UPLOAD_SIGNING_KEY?: string;
			ASSETS?: Fetcher;
			ALLOWED_ORIGINS?: string;
			RP_ID?: string;
			RP_ORIGINS?: string;
			RP_NAME?: string;
			ADMISSION_OFF?: string;
			ENVIRONMENT?: string;
		}
	}
}

export {};
