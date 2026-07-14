// Web Push: VAPID (RFC 8292) + message encryption (RFC 8291 / aes128gcm) using
// only WebCrypto, so it runs inside a Cloudflare Worker with no Node deps.

const enc = new TextEncoder();

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function hkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

// VAPID JWT (ES256), signed with the server private key (JWK in a secret).
export async function vapidToken(env, endpoint) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  };
  const input = bytesToB64url(enc.encode(JSON.stringify(header))) + "." + bytesToB64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input));
  return input + "." + bytesToB64url(sig);
}

// Encrypt `plaintext` (Uint8Array) for a push subscription → aes128gcm body.
export async function encrypt(subscription, plaintext) {
  const uaPublic = b64urlToBytes(subscription.keys.p256dh); // receiver public key (65)
  const authSecret = b64urlToBytes(subscription.keys.auth); // receiver auth secret (16)

  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey)); // ephemeral public (65)
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  // RFC 8291: derive input keying material from ECDH secret + auth secret.
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  // RFC 8188: content key + nonce from a random salt.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(plaintext, new Uint8Array([0x02])); // single record; 0x02 = last-record delimiter
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // Header: salt(16) | record_size(4, BE=4096) | keyid_len(1) | keyid(as_public 65)
  const header = concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ct);
}

// Send one push. Returns the HTTP status (201 = delivered; 404/410 = gone).
export async function sendPush(env, subscription, payloadObj) {
  const body = await encrypt(subscription, enc.encode(JSON.stringify(payloadObj)));
  const jwt = await vapidToken(env, subscription.endpoint);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "high",
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
    },
    body,
  });
  return res.status;
}
