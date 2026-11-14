// The site Worker for Keyprint. Cloudflare serves index.html as a static file and runs this
// script only for requests under /api, which hold accounts. Each account keeps its progress in
// its own Durable Object (a Vault), and one more Durable Object (the Directory) knows every
// username and Google account. CLAUDE.md lists the routes and every answer they give.
//
// It has no imports and uses only Web APIs and the Durable Object SQL API, so a copy of it runs
// in Node for the local tests. Both classes answer plain fetch requests from this script.

/* 1. Configuration --------------------------------------------------------- */

const FRESH = 15 * 60000;        // ms after signing in when adding Google and deleting the account are allowed, APP.freshSignIn in index.html
const IDLE = 90 * 86400000;      // ms a session lasts without being used
const LIFE = 400 * 86400000;     // ms a session lasts at most
const SESSIONS_MAX = 20;         // live sessions an account keeps, the most recently used
const PART = 1048576;            // bytes in each stored part of a saved value
const MAIN_MAX = 8000000;        // bytes in the main copy
const SLOT_MAX = 1000000;        // bytes in a left copy
const DOC_MAX = 12000000;        // bytes in one text, APP.docLimit characters at up to 3 bytes each
const DOCS_BYTES = 24000000;     // bytes of texts an account keeps in all
const DOCS_MAX = 200;            // texts an account keeps
const SLOTS_MAX = 24;            // left copies an account keeps, the most recently written
const KEEP_DAYS = 14;            // daily copies an account keeps, the Daily copies hint in index.html
const PUTS_MAX = 120;            // writes an account may make in 10 minutes
const SIGNUPS_PER_DAY = 500;     // new accounts across the site in one UTC day
const BODY_MAX = 8192;           // characters in a sign in request
const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";
const RESERVED = ["admin", "administrator", "api", "help", "keyprint", "mod", "moderator", "null", "owner", "root", "staff", "support", "system", "undefined"];

const MINUTE = 60000;            // ms in a minute
const HOUR = 60 * MINUTE;        // ms in an hour
const DAY = 24 * HOUR;           // ms in a day
const MAP_MAX = 5000;            // entries each in memory limiter holds before it starts over

const NAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PROOF_RE = /^[A-Za-z0-9_-]{43}$/;
const UID_RE = /^[a-z0-9]{20}$/;
const TOKEN_RE = /^kp1\.([a-z0-9]{20})\.([A-Za-z0-9_-]{43})$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SUB_RE = /^[0-9A-Za-z_-]{1,255}$/;
const MAIN = "keyprint-state-v1";
const SLOT = "keyprint-pending-";
const CAPS = { main: MAIN_MAX, slot: SLOT_MAX, doc: DOC_MAX };
const UID_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

/* 2. Helpers --------------------------------------------------------------- */

const utf8 = (words) => new TextEncoder().encode(words);
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isProof = (proof) => typeof proof === "string" && PROOF_RE.test(proof);
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const secondsUntil = (end, now) => Math.max(1, Math.ceil((end - now) / 1000));
const backoff = (n) => Math.min(15 * MINUTE, 15000 * 2 ** (n - 5));

// Base64url without padding, for anything from an ArrayBuffer or a Uint8Array.
function b64url(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The bytes of a base64url string. A string that isn't base64url throws.
function unb64url(words) {
  const plain = String(words).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(plain + "===".slice((plain.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// A username in its one stored form, or empty when it breaks the rule. Usernames can't be
// renamed, because the password salt in the browser includes them.
function normalName(raw) {
  if (typeof raw !== "string") return "";
  const name = raw.normalize("NFKC").trim().toLowerCase();
  return NAME_RE.test(name) ? name : "";
}

// 20 letters and digits. Bytes of 252 or more are drawn again, so every character is equally likely.
function newUid() {
  let uid = "";
  while (uid.length < 20) {
    for (const byte of randomBytes(32)) {
      if (byte < 252 && uid.length < 20) uid += UID_LETTERS[byte % 36];
    }
  }
  return uid;
}

// Compares two byte arrays in constant time. Node has no timingSafeEqual on crypto.subtle, so
// the tests take the loop, and workerd takes its own.
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// The part of an address that limits count. IPv6 keeps only its first four groups (the /64),
// since one person usually holds a whole /64.
function ipPrefix(ip) {
  const raw = String(ip || "unknown").trim().toLowerCase();
  if (!raw.includes(":")) return raw;
  if (raw.includes(".")) return raw.slice(raw.lastIndexOf(":") + 1); // an IPv4 address written as IPv6
  const halves = raw.split("::");
  if (halves.length > 2) return raw;
  const groups = (part) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const fill = halves.length === 2 ? Math.max(0, 8 - head.length - tail.length) : 0;
  const all = [...head, ...new Array(fill).fill("0"), ...tail];
  return `${all.slice(0, 4).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16).toString(16) : g)).join(":")}::/64`;
}

// The password hash the server keeps. The browser has already run 600,000 rounds of PBKDF2,
// so one HMAC here is enough. The optional PEPPER secret also means a leaked table alone can't
// be checked against guesses.
async function proofHash(alg, salt, proof, pepper) {
  const pep = alg === "kp2";
  const key = await crypto.subtle.importKey("raw", pep ? utf8(pepper) : salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const words = utf8(`${alg}:${proof}`);
  let message = words;
  if (pep) {
    message = new Uint8Array(salt.length + words.length);
    message.set(salt);
    message.set(words, salt.length);
  }
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

// Every answer under /api carries these headers and never any Access-Control header, so other
// sites can't read anything.
const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

function reply(status, body, type) {
  return new Response(body, { status, headers: { ...BASE_HEADERS, "Content-Type": type } });
}

const json = (status, data) => reply(status, JSON.stringify(data), "application/json; charset=utf-8");
const text = (status, words) => reply(status, words, "text/plain; charset=utf-8");

// Reads a request body as bytes, or gives null once it passes max bytes, so a huge upload is
// turned away without holding all of it.
async function readBody(request, max) {
  const length = request.headers.get("Content-Length");
  if (length !== null && Number(length) > max) return null;
  if (!request.body) return new ArrayBuffer(0);
  if (length !== null) {
    const buf = await request.arrayBuffer();
    return buf.byteLength > max ? null : buf;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try {
        await reader.cancel();
      } catch (err) {
        // the answer is already decided, so a stream that won't cancel changes nothing
      }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

// The kind of a Cloud save name, or empty when it isn't one an account keeps.
function nameKind(name) {
  if (name === MAIN) return "main";
  if (name === "keyprint-sync") return "sync";
  if (name === "backups") return "days";
  if (/^keyprint-pending-[a-z0-9]{8,24}$/.test(name)) return "slot";
  if (/^keyprint-doc:[a-z0-9]{4,40}$/.test(name)) return "doc";
  if (/^backup-\d{4}-\d{2}-\d{2}$/.test(name)) return "day";
  return "";
}

/* 3. In memory limits ------------------------------------------------------ */

// These live in each Worker isolate, cost no Durable Object request and store nothing. They only
// slow a flood down before it reaches storage. The exact limits are in the Directory.
const authHits = new Map(); // address to auth POSTs in the current minute
const badHits = new Map();  // address to 401 answers on data routes in the current 10 minutes

// Counts one hit for key in a window of span ms, and says whether the count is still within max.
function tick(map, key, span, max, now) {
  let entry = map.get(key);
  if (!entry || now - entry.start >= span) {
    if (map.size >= MAP_MAX) map.clear();
    entry = { start: now, n: 0 };
    map.set(key, entry);
  }
  entry.n += 1;
  return entry.n <= max;
}

// Says whether key has already reached max hits in its current window, without counting.
function reached(map, key, span, max, now) {
  const entry = map.get(key);
  return Boolean(entry && now - entry.start < span && entry.n >= max);
}

/* 4. Google sign in -------------------------------------------------------- */

// Google's signing keys, kept for as long as Google says and fetched again for a key id it
// hasn't seen, at most once a minute.
const googleKeys = { keys: new Map(), until: 0, tried: -Infinity, loading: null };

async function loadGoogleKeys() {
  const res = await fetch(GOOGLE_KEYS);
  if (!res.ok) throw new Error("jwks");
  const data = await res.json();
  const keys = new Map();
  for (const k of Array.isArray(data && data.keys) ? data.keys : []) {
    if (!k || k.kty !== "RSA" || typeof k.kid !== "string" || typeof k.n !== "string" || typeof k.e !== "string") continue;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      keys.set(k.kid, key);
    } catch (err) {
      // a key that won't import is left out, and tokens signed with it fail
    }
  }
  const age = /max-age=(\d+)/i.exec(res.headers.get("Cache-Control") || "");
  googleKeys.keys = keys;
  googleKeys.until = Date.now() + (age ? clamp(Number(age[1]), 300, 86400) : 3600) * 1000;
}

// The key for kid, or null when Google doesn't publish it. A failed fetch throws, which the
// caller answers with 503.
async function googleKey(kid) {
  const now = Date.now();
  if (now >= googleKeys.until || (!googleKeys.keys.has(kid) && now - googleKeys.tried > MINUTE)) {
    if (!googleKeys.loading) {
      googleKeys.tried = now;
      googleKeys.loading = loadGoogleKeys().finally(() => {
        googleKeys.loading = null;
      });
    }
    await googleKeys.loading;
  }
  return googleKeys.keys.get(kid) || null;
}

const originList = (env) => String(env.GOOGLE_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);

// A failed check logs one word and never the token.
function refuse(status, why) {
  console.error("api", "google", why);
  return { fail: status };
}

// Checks a Google ID token the way Google documents it, and binds it to the proof that only
// the page which started the attempt holds. Gives {sub, email, nonce, exp} or {fail}.
async function verifyGoogle(env, credential, proof, origin) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "");
  if (!clientId || !originList(env).includes(origin)) return refuse(401, "setup");
  if (typeof credential !== "string" || credential.length > 4096 || !JWT_RE.test(credential) || !isProof(proof)) return refuse(400, "shape");
  const [head, load, signature] = credential.split(".");
  let header = null;
  try {
    header = JSON.parse(new TextDecoder().decode(unb64url(head)));
  } catch (err) {
    return refuse(401, "alg");
  }
  if (!header || typeof header !== "object" || header.alg !== "RS256" || (header.typ !== undefined && header.typ !== "JWT")) return refuse(401, "alg");
  if (typeof header.kid !== "string" || !header.kid || header.kid.length > 100) return refuse(401, "kid");
  const key = await googleKey(header.kid);
  if (!key) return refuse(401, "kid");
  let good = false;
  try {
    good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(signature), utf8(`${head}.${load}`));
  } catch (err) {
    good = false;
  }
  if (!good) return refuse(401, "sig");
  let claims = null;
  try {
    claims = JSON.parse(new TextDecoder().decode(unb64url(load)));
  } catch (err) {
    return refuse(401, "shape");
  }
  if (!claims || typeof claims !== "object") return refuse(401, "shape");
  const now = Date.now();
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") return refuse(401, "iss");
  if (claims.aud !== clientId || (claims.azp !== undefined && claims.azp !== clientId)) return refuse(401, "aud");
  if (typeof claims.exp !== "number" || !(claims.exp * 1000 > now - MINUTE)) return refuse(401, "exp");
  if (typeof claims.iat !== "number" || !(claims.iat * 1000 < now + 5 * MINUTE)) return refuse(401, "iat");
  if (typeof claims.sub !== "string" || !SUB_RE.test(claims.sub)) return refuse(401, "sub");
  const nonce = b64url(await crypto.subtle.digest("SHA-256", utf8(proof)));
  if (typeof claims.nonce !== "string" || claims.nonce !== nonce) return refuse(401, "nonce");
  const email = claims.email_verified === true && typeof claims.email === "string" && claims.email.length <= 254 ? claims.email.toLowerCase() : "";
  return { sub: claims.sub, email, nonce, exp: claims.exp };
}

/* 5. Talking to the Durable Objects ---------------------------------------- */

const directory = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
const vault = (env, uid) => env.VAULT.get(env.VAULT.idFromName(uid));
const keyHeaders = (token) => ({ "X-Kp-Secret": token.secret, "X-Kp-Uid": token.uid });

// Posts to an internal route and gives {status, data}. Only this script builds these requests.
// A Durable Object answering 500 or more throws, so the caller answers 503.
async function ask(stub, path, body, headers) {
  const res = await stub.fetch(`https://do/internal/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  if (res.status >= 500) throw new Error(`do ${res.status}`);
  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    // an answer with no JSON body counts as an empty one
  }
  return { status: res.status, data: data && typeof data === "object" ? data : {} };
}

// The token from an Authorization header, or null when it isn't one this site gave out.
function bearer(request) {
  const found = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") || "");
  const parts = found ? TOKEN_RE.exec(found[1]) : null;
  return parts ? { uid: parts[1], secret: parts[2] } : null;
}

/* 6. Auth routes ----------------------------------------------------------- */

function config(env, url) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "");
  const origins = originList(env);
  const listed = origins.includes(url.origin);
  return json(200, {
    v: 1,
    ready: Boolean(env.DIRECTORY && env.VAULT),
    google: clientId && listed ? clientId : "",
    googleAt: clientId && !listed ? origins[0] || "" : "",
  });
}

// Makes a session in the account's Vault and answers with its token. When this fails after
// signing up, the account exists anyway, so a retry gets taken and signing in then works.
async function signedIn(env, found, status, created) {
  if (!found || !UID_RE.test(found.uid)) throw new Error("directory");
  const made = await ask(vault(env, found.uid), "session-new", { uid: found.uid });
  const secret = made.data.secret;
  if (made.status !== 200 || !isProof(secret)) throw new Error("session");
  return json(status, { token: `kp1.${found.uid}.${secret}`, user: found.user, created });
}

async function signup({ env, body, ip }) {
  const name = normalName(body.username);
  if (!name) return json(400, { error: "username" });
  if (!isProof(body.proof)) return json(400, { error: "proof" });
  const r = await ask(directory(env), "signup", { name, proof: body.proof, ip });
  if (r.status !== 200) return json(r.status, r.data);
  return signedIn(env, r.data, 201, true);
}

async function signin({ env, body, ip }) {
  const name = normalName(body.username);
  if (!name) return json(400, { error: "username" });
  if (!isProof(body.proof)) return json(400, { error: "proof" });
  const r = await ask(directory(env), "signin", { name, proof: body.proof, ip });
  if (r.status !== 200) return json(r.status, r.data);
  return signedIn(env, r.data, 200, false);
}

async function google({ env, url, body, ip }) {
  const g = await verifyGoogle(env, body.credential, body.proof, url.origin);
  if (g.fail) return json(g.fail, { error: g.fail === 400 ? "credential" : "google" });
  const r = await ask(directory(env), "google", { sub: g.sub, email: g.email, nonce: g.nonce, exp: g.exp, ip });
  if (r.status !== 200) return json(r.status, r.data);
  const created = r.data.created === true;
  return signedIn(env, r.data, created ? 201 : 200, created);
}

async function signout({ request, env, body }) {
  const token = bearer(request);
  if (!token) return json(401, { error: "session" });
  const r = await ask(vault(env, token.uid), "end", { all: body.all === true }, keyHeaders(token));
  return json(r.status, r.data);
}

async function link({ request, env, url, body, ip }) {
  const token = bearer(request);
  if (!token) return json(401, { error: "session" });
  const fresh = await ask(vault(env, token.uid), "fresh", {}, keyHeaders(token));
  if (fresh.status !== 200) return json(fresh.status, fresh.data);
  const g = await verifyGoogle(env, body.credential, body.proof, url.origin);
  if (g.fail) return json(g.fail, { error: g.fail === 400 ? "credential" : "google" });
  const r = await ask(directory(env), "link", { uid: token.uid, sub: g.sub, email: g.email, nonce: g.nonce, exp: g.exp, ip });
  return json(r.status, r.data);
}

// Changes or adds the password, then signs out every other browser. Those see a plain sign
// out, keep their progress and merge it back when the person signs in there again.
async function password({ request, env, body, ip }) {
  const token = bearer(request);
  if (!token) return json(401, { error: "session" });
  if (!isProof(body.proof)) return json(400, { error: "proof" });
  if (body.old !== undefined && !isProof(body.old)) return json(400, { error: "proof" });
  const check = await ask(vault(env, token.uid), "check", {}, keyHeaders(token));
  if (check.status !== 200) return json(check.status, check.data);
  const name = typeof body.username === "string" ? body.username : "";
  const r = await ask(directory(env), "password", { uid: token.uid, proof: body.proof, old: body.old || "", name, ip });
  if (r.status !== 200) return json(r.status, r.data);
  const others = await ask(vault(env, token.uid), "end-others", {}, keyHeaders(token));
  if (others.status !== 200) return json(others.status, others.data);
  return json(200, { user: r.data.user });
}

// Each step is safe to run again, and the session stays valid until the last one, so a
// failure partway is fixed by trying again.
async function remove({ request, env, body }) {
  const token = bearer(request);
  if (!token) return json(401, { error: "session" });
  if (body.confirm !== "delete") return json(400, { error: "body" });
  const fresh = await ask(vault(env, token.uid), "fresh", {}, keyHeaders(token));
  if (fresh.status !== 200) return json(fresh.status, fresh.data);
  const gone = await ask(directory(env), "remove", { uid: token.uid });
  if (gone.status !== 200) throw new Error("remove");
  const done = await ask(vault(env, token.uid), "delete", {}, keyHeaders(token));
  return json(done.status, done.data);
}

function authRoute(name) {
  if (name === "signup") return signup;
  if (name === "signin") return signin;
  if (name === "google") return google;
  if (name === "signout") return signout;
  if (name === "link") return link;
  if (name === "password") return password;
  if (name === "delete") return remove;
  return null;
}

async function auth(request, env, url, name) {
  if (name === "config") return request.method === "GET" ? config(env, url) : json(405, { error: "method" });
  const run = authRoute(name);
  if (!run) return json(404, { error: "route" });
  if (!env.DIRECTORY || !env.VAULT) return json(500, { error: "setup" });
  if (request.method !== "POST") return json(405, { error: "method" });
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!tick(authHits, ip, MINUTE, 60, Date.now())) return json(429, { error: "busy", retry: 60 });
  const type = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!type.startsWith("application/json")) return json(415, { error: "type" });
  const raw = await readBody(request, BODY_MAX * 3);
  const words = raw === null ? null : new TextDecoder().decode(raw);
  if (words === null || words.length > BODY_MAX) return json(413, { error: "body" });
  let body = null;
  try {
    body = JSON.parse(words);
  } catch (err) {
    // not JSON, which is answered just below
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "body" });
  return run({ request, env, url, body, ip });
}

/* 7. Data routes ----------------------------------------------------------- */

// The Cloud save protocol for one account, with the names, bodies and statuses of
// save-worker.js. The Vault checks the session itself, and the path sent on is built only from
// a name that passed the list, so it can never reach the internal routes.
async function data(request, env, url) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  if (reached(badHits, ip, 10 * MINUTE, 20, now)) return text(429, "Slow down");
  const token = bearer(request);
  if (!token) {
    tick(badHits, ip, 10 * MINUTE, 20, now);
    return text(401, "Signed out");
  }
  let name = "";
  try {
    name = decodeURIComponent(url.pathname.slice(7));
  } catch (err) {
    return text(400, "Bad name");
  }
  const kind = nameKind(name);
  if (!kind) return text(400, "Bad name");
  const method = request.method;
  if (method !== "GET" && method !== "PUT" && method !== "DELETE") return text(405, "Not allowed");
  let body;
  if (method === "PUT" && CAPS[kind]) {
    body = await readBody(request, CAPS[kind]);
    if (body === null) return text(413, "Too large");
  }
  const res = await vault(env, token.uid).fetch(`https://vault/data/${encodeURIComponent(name)}`, { method, headers: keyHeaders(token), body });
  if (res.status >= 500 && res.status !== 507) throw new Error(`vault ${res.status}`); // 507 is Full, the rest a fault
  if (res.status === 401) tick(badHits, ip, 10 * MINUTE, 20, Date.now());
  return reply(res.status, res.body, res.headers.get("Content-Type") || "text/plain; charset=utf-8");
}

/* 8. The Worker ------------------------------------------------------------ */

async function api(request, env, url, area, name) {
  if (request.method === "OPTIONS") return area === "data" ? text(405, "Not allowed") : json(405, { error: "method" });
  const origin = request.headers.get("Origin");
  if (request.method !== "GET" && origin !== null && origin !== url.origin) return area === "data" ? text(403, "Not allowed") : json(403, { error: "origin" });
  if (area === "auth") return auth(request, env, url, name);
  if (area === "data") return env.DIRECTORY && env.VAULT ? data(request, env, url) : text(500, "Setup is not finished");
  return json(404, { error: "route" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    let area = "route";
    let name = "";
    if (url.pathname.startsWith("/api/auth/")) {
      area = "auth";
      name = url.pathname.slice(10);
    } else if (url.pathname.startsWith("/api/u/")) {
      area = "data";
    }
    try {
      return await api(request, env, url, area, name);
    } catch (err) {
      // A passing problem (a Durable Object error, a used up daily limit, full storage) is
      // never answered with 500, which the app would take as a site that isn't set up.
      console.error("api", area === "auth" && authRoute(name) ? name : area, err && err.name);
      return area === "data" ? text(503, "Try again later") : json(503, { error: "later" });
    }
  },
};

/* 9. Vault, one per account ------------------------------------------------ */

// meta holds uid, created and, after a delete, deleted.
// sessions.hash is the base64url SHA-256 of the session secret, created and seen are ms, and
// revoked is 0 or 1.
// blobs is a rowid table on purpose, because SQLite advises against WITHOUT ROWID for big rows.
// name is the Cloud save name, part counts from 0, body is up to PART bytes, size is the byte
// length of that part, and at is the ms of the write.
const VAULT_TABLES = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created INTEGER NOT NULL, seen INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS blobs (name TEXT NOT NULL, part INTEGER NOT NULL, body BLOB NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (name, part))",
];

const VAULT_ROUTES = ["session-new", "check", "fresh", "end", "end-others", "delete"];

// Joins stored parts into one Uint8Array. Bodies come back as ArrayBuffer in workerd, and
// wrapping them works for a Uint8Array too.
function joinParts(rows) {
  const parts = rows.map((row) => new Uint8Array(row.body));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export class Vault {
  // The constructor writes nothing. A token naming a made up uid wakes an object that has no
  // tables, and it must stay that way, so only session-new creates them.
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.ready = false; // whether the tables exist, checked once they do
    this.writes = [];   // ms of this account's recent writes
  }

  has() {
    if (!this.ready) this.ready = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    return this.ready;
  }

  meta(k) {
    const row = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return row ? row.v : "";
  }

  // Checks the session the Worker passed on. Gives {hash, created}, or {fail} with "session"
  // or "revoked". Only the hashing awaits, and the rest runs at once.
  async session(request) {
    const secret = request.headers.get("X-Kp-Secret") || "";
    const uid = request.headers.get("X-Kp-Uid") || "";
    if (!PROOF_RE.test(secret) || !this.has()) return { fail: "session" };
    const hash = b64url(await crypto.subtle.digest("SHA-256", utf8(secret)));
    return this.live(hash, uid, true);
  }

  // The synchronous part of the session check, run again inside each write so a sign out that
  // lands meanwhile wins. A revoked row answers before its age, so a forgotten browser clears
  // itself whenever it comes back. seen moves at most once a day.
  live(hash, uid, touch) {
    if (!this.has()) return { fail: "session" };
    const now = Date.now();
    const row = this.sql.exec("SELECT created, seen, revoked FROM sessions WHERE hash = ?", hash).toArray()[0];
    if (!row) return { fail: "session" };
    if (row.revoked) return { fail: "revoked" };
    if (now - row.seen > IDLE || now - row.created > LIFE) return { fail: "session" };
    if (this.meta("uid") !== uid) return { fail: "session" };
    if (touch && now - row.seen > DAY) this.sql.exec("UPDATE sessions SET seen = ? WHERE hash = ?", now, hash);
    return { hash, uid, created: row.created };
  }

  // Says whether this account has made PUTS_MAX writes in the last 10 minutes, and counts this
  // write when it hasn't.
  tooMany(now) {
    this.writes = this.writes.filter((t) => now - t < 10 * MINUTE);
    if (this.writes.length >= PUTS_MAX) return true;
    this.writes.push(now);
    return false;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/data/")) {
      let name = "";
      try {
        name = decodeURIComponent(path.slice(6));
      } catch (err) {
        return text(400, "Bad name");
      }
      const kind = nameKind(name);
      if (!kind) return text(400, "Bad name");
      return this.data(request, name, kind);
    }
    const route = path.startsWith("/internal/") ? path.slice(10) : "";
    if (request.method !== "POST" || !VAULT_ROUTES.includes(route)) return json(404, { error: "route" });
    return this.internal(request, route);
  }

  async data(request, name, kind) {
    const method = request.method;
    const s = await this.session(request);
    if (s.fail) return text(401, s.fail === "revoked" ? "Revoked" : "Signed out");
    if (method === "GET") return this.read(name, kind);
    if (method === "DELETE") return kind === "doc" ? this.write(s, name, kind, null) : text(403, "Not allowed");
    if (method !== "PUT") return text(405, "Not allowed");
    if (!CAPS[kind]) return text(403, "Not allowed");
    const body = await request.arrayBuffer();
    if (body.byteLength > CAPS[kind]) return text(413, "Too large");
    return this.write(s, name, kind, body);
  }

  parts(name) {
    const rows = this.sql.exec("SELECT body FROM blobs WHERE name = ? ORDER BY part", name).toArray();
    return rows.length ? joinParts(rows) : null;
  }

  read(name, kind) {
    if (kind === "sync") return this.frame();
    if (kind === "days") {
      const rows = this.sql.exec("SELECT DISTINCT name FROM blobs WHERE name >= 'backup-' AND name < 'backup.' ORDER BY name DESC").toArray();
      return text(200, JSON.stringify(rows.map((row) => row.name.slice(7))));
    }
    const body = this.parts(name);
    return body ? reply(200, body, "text/plain; charset=utf-8") : text(404, "Not found");
  }

  // One read that replaces 1 + N GETs per save. A JSON header, one newline, then the raw bytes
  // of the main copy and of each left copy in header order, newest written first. The bodies
  // are copied as stored, with no decoding, which keeps CPU low.
  frame() {
    const main = this.parts(MAIN);
    const rows = this.sql.exec("SELECT name, body, at FROM blobs WHERE name >= 'keyprint-pending-' AND name < 'keyprint-pending.' ORDER BY at DESC, name, part").toArray();
    const slots = [];
    for (const row of rows) {
      const last = slots[slots.length - 1];
      if (last && last.name === row.name) last.rows.push(row);
      else if (slots.length < SLOTS_MAX) slots.push({ name: row.name, rows: [row] });
    }
    const bodies = slots.map((slot) => joinParts(slot.rows));
    const head = utf8(JSON.stringify({ v: 1, main: main ? main.byteLength : -1, slots: slots.map((slot, i) => [slot.name.slice(SLOT.length), bodies[i].byteLength]) }));
    const all = [main || new Uint8Array(0), ...bodies];
    const out = new Uint8Array(head.byteLength + 1 + all.reduce((n, b) => n + b.byteLength, 0));
    out.set(head, 0);
    out[head.byteLength] = 10;
    let at = head.byteLength + 1;
    for (const b of all) {
      out.set(b, at);
      at += b.byteLength;
    }
    return reply(200, out, "application/octet-stream");
  }

  // Writes or deletes one name in a single transaction with no await inside, after checking
  // the session again.
  write(s, name, kind, body) {
    return this.ctx.storage.transactionSync(() => {
      const again = this.live(s.hash, s.uid, false);
      if (again.fail) return text(401, again.fail === "revoked" ? "Revoked" : "Signed out");
      const now = Date.now();
      if (this.tooMany(now)) return text(429, "Slow down");
      if (body === null) {
        this.sql.exec("DELETE FROM blobs WHERE name = ?", name);
        return text(200, "Deleted");
      }
      const size = body.byteLength;
      const known = this.sql.exec("SELECT 1 FROM blobs WHERE name = ? AND part = 0", name).toArray().length > 0;
      if (kind === "doc") {
        const other = this.sql.exec("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(DISTINCT name) AS n FROM blobs WHERE name >= 'keyprint-doc:' AND name < 'keyprint-doc;' AND name <> ?", name).one();
        if (other.bytes + size > DOCS_BYTES || (!known && other.n >= DOCS_MAX)) return text(507, "Full");
      }
      if (kind === "slot" && !known) {
        const slots = this.sql.exec("SELECT COUNT(*) AS n FROM blobs WHERE name >= 'keyprint-pending-' AND name < 'keyprint-pending.' AND part = 0").one();
        if (slots.n >= SLOTS_MAX) {
          this.sql.exec("DELETE FROM blobs WHERE name IN (SELECT name FROM blobs WHERE name >= 'keyprint-pending-' AND name < 'keyprint-pending.' AND part = 0 ORDER BY at, name LIMIT ?)", slots.n - SLOTS_MAX + 1);
        }
      }
      const count = Math.max(1, Math.ceil(size / PART));
      for (let i = 0; i < count && size; i++) {
        const piece = body.slice(i * PART, Math.min(size, (i + 1) * PART));
        this.sql.exec("INSERT INTO blobs (name, part, body, size, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name, part) DO UPDATE SET body = excluded.body, size = excluded.size, at = excluded.at", name, i, piece, piece.byteLength, now);
      }
      // SQLite binds an empty buffer as NULL, so an empty copy is written as the empty BLOB.
      if (!size) this.sql.exec("INSERT INTO blobs (name, part, body, size, at) VALUES (?, 0, X'', 0, ?) ON CONFLICT (name, part) DO UPDATE SET body = excluded.body, size = excluded.size, at = excluded.at", name, now);
      this.sql.exec("DELETE FROM blobs WHERE name = ? AND part >= ?", name, count);
      if (kind === "main") this.daily(now);
      return text(200, "Saved");
    });
  }

  // Keeps the first main copy of each UTC day, the same rule as save-worker.js, copied inside
  // SQLite without sending the data again, and only the newest KEEP_DAYS of them.
  daily(now) {
    const day = `backup-${utcDay(now)}`;
    if (this.sql.exec("SELECT 1 FROM blobs WHERE name = ? AND part = 0", day).toArray().length) return;
    this.sql.exec("INSERT INTO blobs (name, part, body, size, at) SELECT ?, part, body, size, at FROM blobs WHERE name = ?", day, MAIN);
    this.sql.exec("DELETE FROM blobs WHERE name >= 'backup-' AND name < 'backup.' AND name NOT IN (SELECT DISTINCT name FROM blobs WHERE name >= 'backup-' AND name < 'backup.' ORDER BY name DESC LIMIT ?)", KEEP_DAYS);
  }

  async internal(request, route) {
    const body = await request.json();
    if (route === "session-new") return this.sessionNew(body);
    const s = await this.session(request);
    if (s.fail) return json(401, { error: s.fail });
    const now = Date.now();
    if (route === "check") return json(200, { created: s.created });
    if (route === "fresh") return now - s.created > FRESH ? json(403, { error: "recent" }) : json(200, { ok: true });
    if (route === "end") {
      this.ctx.storage.transactionSync(() => {
        if (body.all === true) this.sql.exec("UPDATE sessions SET revoked = 1");
        else this.sql.exec("UPDATE sessions SET revoked = 1 WHERE hash = ?", s.hash);
      });
      return json(200, { ok: true });
    }
    if (route === "end-others") {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM sessions WHERE hash <> ? AND revoked = 0", s.hash);
      });
      return json(200, { ok: true });
    }
    // Deleting keeps the revoked session rows until the alarm, so every other browser that's
    // still signed in learns Revoked and clears itself.
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM blobs");
      this.sql.exec("UPDATE sessions SET revoked = 1");
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('deleted', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(now));
    });
    await this.ctx.storage.setAlarm(now + LIFE);
    return json(200, { ok: true });
  }

  // Creates the tables on first use, then a session. Keeps the 19 most recently seen live
  // sessions before adding the new one, so a browser pushed out sees a plain sign out.
  async sessionNew(body) {
    const uid = String(body.uid || "");
    if (!UID_RE.test(uid)) return json(400, { error: "body" });
    const secret = b64url(randomBytes(32));
    const hash = b64url(await crypto.subtle.digest("SHA-256", utf8(secret)));
    const now = Date.now();
    const made = this.ctx.storage.transactionSync(() => {
      for (const q of VAULT_TABLES) this.sql.exec(q);
      const owner = this.meta("uid");
      if (owner && owner !== uid) throw new Error("vault owner");
      if (this.meta("deleted")) return false;
      this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('uid', ?)", uid);
      this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('created', ?)", String(now));
      this.sql.exec("DELETE FROM sessions WHERE (revoked = 1 AND created < ?) OR (revoked = 0 AND (seen < ? OR created < ?))", now - LIFE, now - IDLE, now - LIFE);
      this.sql.exec("DELETE FROM sessions WHERE revoked = 0 AND hash NOT IN (SELECT hash FROM sessions WHERE revoked = 0 ORDER BY seen DESC, created DESC LIMIT ?)", SESSIONS_MAX - 1);
      this.sql.exec("INSERT INTO sessions (hash, created, seen, revoked) VALUES (?, ?, ?, 0)", hash, now, now);
      return true;
    });
    this.ready = true;
    return made ? json(200, { secret }) : json(409, { error: "deleted" });
  }

  // Removes what a deleted account left behind, the revoked session rows, once every browser
  // has had LIFE to learn it was revoked.
  async alarm() {
    if (!this.has() || !this.meta("deleted")) return;
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }
}

/* 10. Directory, one for the site ------------------------------------------ */

// users has one row per account. username is empty for an account with only Google, and email
// is shown only, never used to match accounts.
// logins.login is "pw" or "g" and a colon, then the username or the Google sub. salt, hash and
// alg are set only for password logins.
// limits.k is a counter name, n the count, at the last counted attempt and until when the row
// can go.
// used.k is "n" and a colon, then the nonce of a Google sign in already taken.
// meta holds key (for hashing addresses), signups (the UTC day and its count) and pruned.
const DIRECTORY_TABLES = [
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS logins (login TEXT PRIMARY KEY, user TEXT NOT NULL, salt TEXT, hash TEXT, alg TEXT, created INTEGER NOT NULL) WITHOUT ROWID",
  "CREATE INDEX IF NOT EXISTS logins_user ON logins (user)",
  "CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, at INTEGER NOT NULL, until INTEGER NOT NULL) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS used (k TEXT PRIMARY KEY, until INTEGER NOT NULL) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
];

const busy = (wait) => json(429, { error: "busy", retry: wait });

// Every limit here is exact, because the Directory is a single strongly consistent object and
// each count runs synchronously before the first await that follows it.
export class Directory {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    for (const q of DIRECTORY_TABLES) this.sql.exec(q);
    if (!this.meta("key")) this.setMeta("key", b64url(randomBytes(32)));
    this.prunedAt = Number(this.meta("pruned")) || 0;
    this.ipKey = null; // the HMAC key for addresses, imported once
  }

  pepper() {
    return typeof this.env.PEPPER === "string" ? this.env.PEPPER : "";
  }

  meta(k) {
    const row = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return row ? row.v : "";
  }

  setMeta(k, v) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  login(k) {
    return this.sql.exec("SELECT login, user, salt, hash, alg FROM logins WHERE login = ?", k).toArray()[0] || null;
  }

  // The user JSON every auth route answers with, or null for an unknown uid.
  user(uid) {
    const u = this.sql.exec("SELECT id, username, email FROM users WHERE id = ?", uid).toArray()[0];
    if (!u) return null;
    const logins = this.sql.exec("SELECT login FROM logins WHERE user = ?", uid).toArray();
    return {
      id: u.id,
      name: u.username || u.email || "Google account",
      username: u.username,
      email: u.email,
      google: logins.some((row) => row.login.startsWith("g:")),
      password: logins.some((row) => row.login.startsWith("pw:")),
    };
  }

  freshUid() {
    let uid = newUid();
    while (this.sql.exec("SELECT 1 FROM users WHERE id = ?", uid).toArray().length) uid = newUid();
    return uid;
  }

  // The first 16 characters of a keyed hash of the address. Raw addresses are never stored.
  async ipHash(ip) {
    if (!this.ipKey) this.ipKey = crypto.subtle.importKey("raw", unb64url(this.meta("key")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    let key;
    try {
      key = await this.ipKey;
    } catch (err) {
      this.ipKey = null;
      throw err;
    }
    return b64url(await crypto.subtle.sign("HMAC", key, utf8(ipPrefix(ip)))).slice(0, 16);
  }

  // Deletes expired counters and used nonces, at most once every 10 minutes.
  prune(now) {
    if (now - this.prunedAt < 10 * MINUTE) return;
    this.prunedAt = now;
    this.sql.exec("DELETE FROM limits WHERE until <= ?", now);
    this.sql.exec("DELETE FROM used WHERE until <= ?", now);
    this.setMeta("pruned", String(now));
  }

  limit(k) {
    return this.sql.exec("SELECT n, at, until FROM limits WHERE k = ?", k).toArray()[0] || null;
  }

  // The seconds left in the window when counter k has reached cap, otherwise 0.
  full(k, cap, now) {
    const row = this.limit(k);
    return row && now < row.until && row.n >= cap ? secondsUntil(row.until, now) : 0;
  }

  // Counts one attempt against cap in a window of span ms. Gives the seconds to wait when the
  // cap was already reached, and then counts nothing.
  count(k, cap, span, now) {
    const row = this.limit(k);
    if (row && now < row.until) {
      if (row.n >= cap) return secondsUntil(row.until, now);
      this.sql.exec("UPDATE limits SET n = n + 1, at = ? WHERE k = ?", now, k);
      return 0;
    }
    this.sql.exec("INSERT INTO limits (k, n, at, until) VALUES (?, 1, ?, ?) ON CONFLICT (k) DO UPDATE SET n = 1, at = excluded.at, until = excluded.until", k, now, now + span);
    return 0;
  }

  signupsToday(now) {
    const [day, n] = this.meta("signups").split(" ");
    return day === utcDay(now) ? Number(n) || 0 : 0;
  }

  countSignup(now) {
    this.setMeta("signups", `${utcDay(now)} ${this.signupsToday(now) + 1}`);
  }

  // The sign in limits, counted before the password is checked so a burst of guesses can't
  // slip past them. Gives {wait} in seconds, or {login} with the password login row or null.
  gate(name, h, now) {
    this.prune(now);
    const wait = this.count(`i:${h}`, 120, 10 * MINUTE, now);
    if (wait) return { wait };
    const fk = `f:${name}:${h}`;
    const f = this.limit(fk);
    const live = Boolean(f && now < f.until);
    if (live && f.n >= 5 && now < f.at + backoff(f.n)) return { wait: secondsUntil(f.at + backoff(f.n), now) };
    const held = this.full(`u:${name}`, 50, now);
    if (held) return { wait: held };
    this.sql.exec("INSERT INTO limits (k, n, at, until) VALUES (?, ?, ?, ?) ON CONFLICT (k) DO UPDATE SET n = excluded.n, at = excluded.at, until = excluded.until", fk, live ? f.n + 1 : 1, now, now + DAY);
    this.count(`u:${name}`, 50, HOUR, now);
    return { login: this.login(`pw:${name}`) };
  }

  // A right password clears this address's failures and gives the name back one attempt.
  passed(name, h) {
    this.sql.exec("DELETE FROM limits WHERE k = ?", `f:${name}:${h}`);
    this.sql.exec("UPDATE limits SET n = MAX(n - 1, 0) WHERE k = ?", `u:${name}`);
  }

  // Whether proof matches the row. An unknown username runs the same HMAC against a zero salt,
  // so it answers like a wrong password. Gives "pepper" for a kp2 row with PEPPER missing.
  async matches(row, proof) {
    const pepper = this.pepper();
    const alg = row ? row.alg : pepper ? "kp2" : "kp1";
    if (alg === "kp2" && !pepper) return "pepper";
    const got = await proofHash(alg, row ? unb64url(row.salt) : new Uint8Array(16), proof, pepper);
    return sameBytes(got, row ? unb64url(row.hash) : new Uint8Array(32)) && Boolean(row);
  }

  async newHash(proof) {
    const salt = randomBytes(16);
    const alg = this.pepper() ? "kp2" : "kp1";
    return { salt: b64url(salt), alg, hash: b64url(await proofHash(alg, salt, proof, this.pepper())) };
  }

  later(why) {
    console.error("api", why);
    return json(503, { error: "later" });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !path.startsWith("/internal/")) return json(404, { error: "route" });
    const route = path.slice(10);
    if (route === "signup") return this.signup(await request.json());
    if (route === "signin") return this.signin(await request.json());
    if (route === "google") return this.google(await request.json());
    if (route === "link") return this.link(await request.json());
    if (route === "password") return this.password(await request.json());
    if (route === "remove") return this.remove(await request.json());
    return json(404, { error: "route" });
  }

  async signup(body) {
    const name = normalName(body.name);
    if (!name) return json(400, { error: "username" });
    if (!isProof(body.proof)) return json(400, { error: "proof" });
    const h = await this.ipHash(body.ip);
    const now = Date.now();
    const first = this.ctx.storage.transactionSync(() => {
      this.prune(now);
      const wait = this.count(`s:${h}`, 40, HOUR, now);
      if (wait) return busy(wait);
      if (this.signupsToday(now) >= SIGNUPS_PER_DAY) return json(429, { error: "closed" });
      if (RESERVED.includes(name) || this.login(`pw:${name}`)) return json(409, { error: "taken" });
      return null;
    });
    if (first) return first;
    const made = await this.newHash(body.proof);
    return this.ctx.storage.transactionSync(() => {
      if (this.login(`pw:${name}`)) return json(409, { error: "taken" });
      if (this.signupsToday(now) >= SIGNUPS_PER_DAY) return json(429, { error: "closed" });
      const uid = this.freshUid();
      this.sql.exec("INSERT INTO users (id, username, email, created) VALUES (?, ?, '', ?)", uid, name, now);
      this.sql.exec("INSERT INTO logins (login, user, salt, hash, alg, created) VALUES (?, ?, ?, ?, ?, ?)", `pw:${name}`, uid, made.salt, made.hash, made.alg, now);
      this.countSignup(now);
      return json(200, { uid, user: this.user(uid) });
    });
  }

  async signin(body) {
    const name = normalName(body.name);
    if (!name) return json(400, { error: "username" });
    if (!isProof(body.proof)) return json(400, { error: "proof" });
    const h = await this.ipHash(body.ip);
    const now = Date.now();
    const gate = this.ctx.storage.transactionSync(() => this.gate(name, h, now));
    if (gate.wait) return busy(gate.wait);
    const verdict = await this.matches(gate.login, body.proof);
    if (verdict === "pepper") return this.later("pepper");
    const row = gate.login;
    const user = verdict ? this.user(row.user) : null;
    if (!user) return json(401, { error: "wrong" });
    // A kp1 row is hashed again with the pepper once the PEPPER secret is set.
    const upgrade = row.alg === "kp1" && this.pepper() ? b64url(await proofHash("kp2", unb64url(row.salt), body.proof, this.pepper())) : "";
    this.ctx.storage.transactionSync(() => {
      this.passed(name, h);
      if (upgrade) this.sql.exec("UPDATE logins SET hash = ?, alg = 'kp2' WHERE login = ? AND hash = ?", upgrade, row.login, row.hash);
    });
    return json(200, { uid: row.user, user });
  }

  // Counts a Google attempt and takes its nonce, so each credential works only once. Gives
  // null to go on, or an answer.
  spend(h, nonce, exp, now) {
    this.prune(now);
    const wait = this.count(`i:${h}`, 120, 10 * MINUTE, now);
    if (wait) return busy(wait);
    const k = `n:${nonce}`;
    if (this.sql.exec("SELECT 1 FROM used WHERE k = ?", k).toArray().length) {
      console.error("api", "google", "used");
      return json(401, { error: "google" });
    }
    this.sql.exec("INSERT INTO used (k, until) VALUES (?, ?)", k, exp * 1000 + MINUTE);
    return null;
  }

  // Signs in with Google, or makes a new account for a Google account it hasn't seen. Accounts
  // are never matched or linked by email.
  async google(body) {
    const sub = String(body.sub || "");
    const email = typeof body.email === "string" ? body.email : "";
    const nonce = String(body.nonce || "");
    const exp = Number(body.exp);
    if (!SUB_RE.test(sub) || !nonce || !Number.isFinite(exp)) return json(401, { error: "google" });
    const h = await this.ipHash(body.ip);
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const first = this.spend(h, nonce, exp, now);
      if (first) return first;
      const login = this.login(`g:${sub}`);
      if (login) {
        if (email) this.sql.exec("UPDATE users SET email = ? WHERE id = ? AND email <> ?", email, login.user, email);
        return json(200, { uid: login.user, user: this.user(login.user), created: false });
      }
      const wait = this.count(`s:${h}`, 40, HOUR, now);
      if (wait) return busy(wait);
      if (this.signupsToday(now) >= SIGNUPS_PER_DAY) return json(429, { error: "closed" });
      const uid = this.freshUid();
      this.sql.exec("INSERT INTO users (id, username, email, created) VALUES (?, '', ?, ?)", uid, email, now);
      this.sql.exec("INSERT INTO logins (login, user, created) VALUES (?, ?, ?)", `g:${sub}`, uid, now);
      this.countSignup(now);
      return json(200, { uid, user: this.user(uid), created: true });
    });
  }

  async link(body) {
    const uid = String(body.uid || "");
    const sub = String(body.sub || "");
    const email = typeof body.email === "string" ? body.email : "";
    const nonce = String(body.nonce || "");
    const exp = Number(body.exp);
    if (!SUB_RE.test(sub) || !nonce || !Number.isFinite(exp)) return json(401, { error: "google" });
    const h = await this.ipHash(body.ip);
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const first = this.spend(h, nonce, exp, now);
      if (first) return first;
      const user = this.user(uid);
      if (!user) return json(401, { error: "session" });
      const login = this.login(`g:${sub}`);
      if (login) return login.user === uid ? json(200, { user }) : json(409, { error: "linked" });
      if (user.google) return json(409, { error: "has" });
      this.sql.exec("INSERT INTO logins (login, user, created) VALUES (?, ?, ?)", `g:${sub}`, uid, now);
      if (email) this.sql.exec("UPDATE users SET email = ? WHERE id = ?", email, uid);
      return json(200, { user: this.user(uid) });
    });
  }

  // With a password, the current one is checked under the sign in limits, keyed by the
  // account's username. A Google only account names its username here instead.
  async password(body) {
    const uid = String(body.uid || "");
    if (!this.user(uid)) return json(401, { error: "session" });
    if (!isProof(body.proof)) return json(400, { error: "proof" });
    const pw = this.sql.exec("SELECT login FROM logins WHERE user = ? AND login >= 'pw:' AND login < 'pw;'", uid).toArray()[0];
    if (pw) {
      const name = pw.login.slice(3);
      if (!isProof(body.old)) return json(401, { error: "wrong" });
      const h = await this.ipHash(body.ip);
      const now = Date.now();
      const gate = this.ctx.storage.transactionSync(() => this.gate(name, h, now));
      if (gate.wait) return busy(gate.wait);
      const verdict = await this.matches(gate.login, body.old);
      if (verdict === "pepper") return this.later("pepper");
      if (!verdict || gate.login.user !== uid) return json(401, { error: "wrong" });
      const made = await this.newHash(body.proof);
      this.ctx.storage.transactionSync(() => {
        this.passed(name, h);
        this.sql.exec("UPDATE logins SET salt = ?, hash = ?, alg = ? WHERE login = ?", made.salt, made.hash, made.alg, pw.login);
      });
      return json(200, { user: this.user(uid) });
    }
    const name = normalName(body.name);
    if (!name) return json(400, { error: "username" });
    if (RESERVED.includes(name) || this.login(`pw:${name}`)) return json(409, { error: "taken" });
    const made = await this.newHash(body.proof);
    const now = Date.now();
    const added = this.ctx.storage.transactionSync(() => {
      if (this.login(`pw:${name}`)) return false;
      if (this.sql.exec("SELECT 1 FROM logins WHERE user = ? AND login >= 'pw:' AND login < 'pw;'", uid).toArray().length) return false;
      this.sql.exec("INSERT INTO logins (login, user, salt, hash, alg, created) VALUES (?, ?, ?, ?, ?, ?)", `pw:${name}`, uid, made.salt, made.hash, made.alg, now);
      this.sql.exec("UPDATE users SET username = ? WHERE id = ?", name, uid);
      return true;
    });
    return added ? json(200, { user: this.user(uid) }) : json(409, { error: "taken" });
  }

  remove(body) {
    const uid = String(body.uid || "");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM logins WHERE user = ?", uid);
      this.sql.exec("DELETE FROM users WHERE id = ?", uid);
    });
    return json(200, { ok: true });
  }
}
