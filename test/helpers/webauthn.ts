/**
 * A software authenticator for tests: genuine attestation-none registrations
 * and ES256 assertions, built from the options the server sends. Test data
 * generation only, not an alternate WebAuthn verifier.
 */
const encode = (text: string) => new TextEncoder().encode(text);
const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) { result.set(part, offset); offset += part.length; }
	return result;
};
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unb64 = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
const hash = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

function cbor(value: number | string | Uint8Array | Map<number | string, any>): Uint8Array<ArrayBuffer> {
	const head = (major: number, size: number) => size < 24 ? new Uint8Array([major * 32 + size]) : new Uint8Array([major * 32 + 24, size]);
	if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
	if (typeof value === 'string') return join(head(3, encode(value).length), encode(value));
	if (value instanceof Uint8Array) return join(head(2, value.length), value);
	return join(head(5, value.size), ...Array.from(value, ([key, item]) => join(cbor(key), cbor(item))));
}

function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
	const integer = (part: Uint8Array) => {
		while (part.length > 1 && part[0] === 0) part = part.slice(1);
		if (part[0] & 128) part = join(new Uint8Array([0]), part);
		return join(new Uint8Array([2, part.length]), part);
	};
	const content = join(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return join(new Uint8Array([0x30, content.length]), content);
}

/** One passkey: `register` answers creation options, `assert` request options, both for `origin`. */
export async function softPasskey(origin: string) {
	const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
	const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
	const rawId = crypto.getRandomValues(new Uint8Array(32));
	const id = b64(rawId);
	const cose = cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, unb64(jwk.x!)], [-3, unb64(jwk.y!)]]));
	const clientData = (challenge: string, type: string) => encode(JSON.stringify({ type, challenge, origin }));
	return {
		id,
		async register(options: { challenge: string; rp: { id: string } }) {
			const authData = join(await hash(encode(options.rp.id)), new Uint8Array([0x45, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, rawId.length]), rawId, cose);
			return { id, rawId: id, type: 'public-key', response: {
				clientDataJSON: b64(clientData(options.challenge, 'webauthn.create')),
				attestationObject: b64(cbor(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
			}, clientExtensionResults: { credProps: { rk: true } } };
		},
		async assert(options: { challenge: string; rpId: string }, counter = 1) {
			const data = clientData(options.challenge, 'webauthn.get');
			const authData = join(await hash(encode(options.rpId)), new Uint8Array([5, 0, 0, 0, counter]));
			const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, join(authData, await hash(data))));
			return { id, rawId: id, type: 'public-key', response: {
				clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(derSignature(raw)),
			}, clientExtensionResults: {} };
		},
	};
}
