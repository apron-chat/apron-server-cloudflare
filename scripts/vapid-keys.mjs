// Prints a new VAPID key pair (RFC 8292) for Web Push, as the unpadded
// base64url values VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY take. See
// docs/configuration.md, Push.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
console.log(`VAPID_PUBLIC_KEY=${Buffer.from(raw).toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${d}`);
