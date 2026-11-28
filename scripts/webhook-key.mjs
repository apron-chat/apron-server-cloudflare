// Prints a new Ed25519 signing key for push kind `webhook` (protocol §4.9.4)
// in Standard Webhooks' serialization: WEBHOOK_SIGNING_KEY, the `whsk_`
// secret key (the 32-byte seed, base64), and the `whpk_` public key that
// `server.push.webhook.signature_keys` will advertise. See
// docs/configuration.md, Webhooks.
const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
console.log(`WEBHOOK_SIGNING_KEY=whsk_${Buffer.from(d, 'base64url').toString('base64')}`);
console.log(`# public key: whpk_${Buffer.from(publicKey).toString('base64')}`);
