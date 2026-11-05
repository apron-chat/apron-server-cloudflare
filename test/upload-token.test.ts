import { describe, expect, it } from "vitest";
import { looksLikeUploadToken, signUploadToken, verifyUploadToken } from "../src/upload-token";

describe("upload token shape", () => {
	const secret = "test-upload-signing-key-0123456789abcdef";
	const now = Date.parse("2026-11-05T12:00:00Z");

	it("recognizes a signed token by shape and expiry alone, before its signature is checked", async () => {
		const token = await signUploadToken(secret, { key: "f/AAAAAAAAAAAAAAAAAAAAAA", maxBytes: 5_242_880, expiresMs: now + 60_000 });
		expect(looksLikeUploadToken(token, now)).toBe(true);
		expect(await verifyUploadToken(secret, token, now)).toMatchObject({ key: "f/AAAAAAAAAAAAAAAAAAAAAA", maxBytes: 5_242_880 });
		// Expired, however well signed.
		expect(looksLikeUploadToken(token, now + 60_000)).toBe(false);
		// The wrong shape: a part missing, a short id, a short signature, a stray character, too long.
		expect(looksLikeUploadToken(token.split(".").slice(0, 4).join("."), now)).toBe(false);
		expect(looksLikeUploadToken(token.replace(/^f\.A/, "f."), now)).toBe(false);
		expect(looksLikeUploadToken(token.slice(0, -1), now)).toBe(false);
		expect(looksLikeUploadToken(`${token}!`, now)).toBe(false);
		expect(looksLikeUploadToken(`${token}${"A".repeat(60)}`, now)).toBe(false);
		expect(looksLikeUploadToken("", now)).toBe(false);
		// A token that passes the shape test but not the signature still fails verification.
		const forged = token.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
		expect(looksLikeUploadToken(forged, now)).toBe(true);
		expect(await verifyUploadToken(secret, forged, now)).toBeNull();
	});
});
