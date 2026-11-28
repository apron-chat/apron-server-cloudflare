import { describe, expect, it } from "vitest";
import {
	base64Decode, base64Encode, checkVerificationResponse, importWebhookSigningKey, newWebhookId, parseWebhookSigningKeys, retryDelay, signWebhook,
	signWebhookToken, verificationResponse, verifyWebhookSignature, verifyWebhookToken, WEBHOOK_TOKEN_PREFIX,
} from "../src/webhook";

// The asymmetric (`v2a`) test vectors of the Standard Webhooks spec and of its
// endpoint verification extension, which the official JavaScript library's
// tests (libraries/javascript/src/webhook.test.ts) use too.
const SECRET = "whsk_4uKPjji/dhB8w6GW3YYDnIMYvXcdHrvH6lidTr4Z+EY=";
const PUBLIC = "whpk_uWKK13PfwqyOgrqT0OrWKcS2uVD7e89+oUKnkoPjx7w=";
const ENDPOINT = "ep_2fVZdC8Kx9TR4ZoCqHWt3NnLgRb";
const MSG = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
const TIMESTAMP = 1674087231;
const PAYLOAD = `{"type":"contact.created","timestamp":"2022-11-03T20:26:10.344522Z","data":{"id":"1f81eb52-5198-4599-803e-771906343485"}}`;
const SIGNATURE = "v2a,kG9XaxZjAEpKB8KeQQb5G1Xp73YH5Rf5gxoWe7cg1kYMiyspdtZXe9w+dAwKeOurAwxfqmlOG/QR4m9s37DzAg==";
const CHALLENGE = "0njH7N3kV5eXPB+/eh+eoA2Ahvz2JgNp0iC/BLOl6yM=";
const CHALLENGE_RESPONSE = "v2a,t0RDFhzk7OtVzgvMsjuXnodSWuby2BVX+zPqw2/ksUk=";
const OTHER = `whsk_${base64Encode(new Uint8Array(32).fill(7))}`;

describe("Standard Webhooks v2a", () => {
	it("derives the spec's public key and signs its vector", async () => {
		const key = await importWebhookSigningKey(SECRET);
		expect(key.publicText).toBe(PUBLIC);
		expect(await signWebhook([key], ENDPOINT, MSG, TIMESTAMP, PAYLOAD)).toBe(SIGNATURE);
		expect(await verifyWebhookSignature([key.publicKey], ENDPOINT, MSG, TIMESTAMP, PAYLOAD, SIGNATURE)).toBe(true);
		// Another endpoint, message, time or body fails.
		expect(await verifyWebhookSignature([key.publicKey], "ep_other", MSG, TIMESTAMP, PAYLOAD, SIGNATURE)).toBe(false);
		expect(await verifyWebhookSignature([key.publicKey], ENDPOINT, MSG, TIMESTAMP + 1, PAYLOAD, SIGNATURE)).toBe(false);
		expect(await verifyWebhookSignature([key.publicKey], ENDPOINT, MSG, TIMESTAMP, `${PAYLOAD} `, SIGNATURE)).toBe(false);
	});

	it("signs with each key while they rotate, space separated", async () => {
		const [current, previous] = await Promise.all([importWebhookSigningKey(OTHER), importWebhookSigningKey(SECRET)]);
		const header = await signWebhook([current, previous], ENDPOINT, MSG, TIMESTAMP, PAYLOAD);
		expect(header.split(" ")).toHaveLength(2);
		expect(header.split(" ")[1]).toBe(SIGNATURE);
		expect(await verifyWebhookSignature([previous.publicKey], ENDPOINT, MSG, TIMESTAMP, PAYLOAD, header)).toBe(true);
		expect(await verifyWebhookSignature([current.publicKey], ENDPOINT, MSG, TIMESTAMP, PAYLOAD, header)).toBe(true);
		await expect(signWebhook([current], "ep.dot", MSG, TIMESTAMP, PAYLOAD)).rejects.toThrow();
	});

	it("answers and checks the endpoint verification vector", async () => {
		const key = await importWebhookSigningKey(SECRET);
		const publicKey = base64Decode(PUBLIC.slice(5))!;
		expect(await verificationResponse(publicKey, ENDPOINT, CHALLENGE)).toBe(CHALLENGE_RESPONSE);
		expect(await checkVerificationResponse([key], ENDPOINT, CHALLENGE, CHALLENGE_RESPONSE)).toBe(true);
		const other = await importWebhookSigningKey(OTHER);
		// Any active key passes; a wrong endpoint, a list, an echo, or none fails.
		expect(await checkVerificationResponse([other, key], ENDPOINT, CHALLENGE, CHALLENGE_RESPONSE)).toBe(true);
		expect(await checkVerificationResponse([key], "ep_other", CHALLENGE, CHALLENGE_RESPONSE)).toBe(false);
		expect(await checkVerificationResponse([key], ENDPOINT, CHALLENGE, `${CHALLENGE_RESPONSE} ${CHALLENGE_RESPONSE}`)).toBe(false);
		expect(await checkVerificationResponse([key], ENDPOINT, CHALLENGE, CHALLENGE)).toBe(false);
		expect(await checkVerificationResponse([key], ENDPOINT, CHALLENGE, null)).toBe(false);
	});

	it("parses WEBHOOK_SIGNING_KEY as whsk_ keys only", () => {
		expect(parseWebhookSigningKeys(` ${SECRET}, ${OTHER} `)).toEqual([SECRET, OTHER]);
		for (const raw of ["", "whsk_", `whsk_${base64Encode(new Uint8Array(31))}`, PUBLIC, `${SECRET} ${SECRET}`, `${SECRET} ${OTHER} ${SECRET.slice(0, -2)}x= ${OTHER}`]) {
			expect(() => parseWebhookSigningKeys(raw), raw).toThrow();
		}
	});

	it("makes IDs without a dot", () => {
		for (let index = 0; index < 50; index++) {
			expect(newWebhookId("wh_")).toMatch(/^wh_[A-Za-z0-9_-]{16}$/);
			expect(newWebhookId("msg_")).toMatch(/^msg_[A-Za-z0-9_-]{16}$/);
		}
	});

	it("honours Retry-After within bounds only", () => {
		expect(retryDelay({ status: 503, challengeResponse: null }, 0)).toBe(5_000);
		expect(retryDelay({ status: 503, challengeResponse: null, retryAfterMs: 20_000 }, 0)).toBe(20_000);
		expect(retryDelay({ status: 429, challengeResponse: null, retryAfterMs: 3_600_000 }, 0)).toBeUndefined();
		expect(retryDelay({ status: 503, challengeResponse: null }, 2)).toBeUndefined();
	});
});

describe("call tokens", () => {
	it("signs a grant, checks it until it expires, and refuses any change", async () => {
		const key = await importWebhookSigningKey(SECRET);
		const other = await importWebhookSigningKey(OTHER);
		const now = 1_800_000_000_000;
		const grant = { userId: "bot_ada", createdMs: 1_700_000_000_123, expiresMs: now + 900_000 };
		const token = await signWebhookToken(key, grant);
		expect(token.startsWith(WEBHOOK_TOKEN_PREFIX)).toBe(true);
		expect(token.length).toBeLessThanOrEqual(256);
		expect(await verifyWebhookToken([key], token, now)).toEqual(grant);
		// A rotated-out key still checks it; an unknown key does not.
		expect(await verifyWebhookToken([other, key], token, now)).toEqual(grant);
		expect(await verifyWebhookToken([other], token, now)).toBeNull();
		expect(await verifyWebhookToken([key], token, grant.expiresMs)).toBeNull();
		const parts = token.slice(WEBHOOK_TOKEN_PREFIX.length).split(".");
		const forged = [btoa("bot_eve").replace(/=+$/, ""), ...parts.slice(1)].join(".");
		expect(await verifyWebhookToken([key], WEBHOOK_TOKEN_PREFIX + forged, now)).toBeNull();
		const later = [parts[0], parts[1], String(grant.expiresMs + 1), parts[3]].join(".");
		expect(await verifyWebhookToken([key], WEBHOOK_TOKEN_PREFIX + later, now)).toBeNull();
		expect(await verifyWebhookToken([key], `apron_bot_${parts.join(".")}`, now)).toBeNull();
		// A user_id with other characters round-trips.
		const odd = { ...grant, userId: "bot_ünïcode-π" };
		expect(await verifyWebhookToken([key], await signWebhookToken(key, odd), now)).toEqual(odd);
	});
});
