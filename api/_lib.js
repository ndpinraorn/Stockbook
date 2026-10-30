// Shared helpers for the API routes (files starting with "_" are not routes on Vercel).
// Storage: Upstash Redis over its REST API, so no npm packages are needed.
// Connect it in Vercel: Project → Storage → Upstash (Redis) → Connect. Vercel then adds
// KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN) for you.

const crypto = require("crypto");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const SESSION_DAYS = 120;

const configured = () => !!(URL_ && TOKEN);

async function kv(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(URL_.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("pipeline failed");
  const bad = j.find((x) => x && x.error);
  if (bad) throw new Error(bad.error);
  return j.map((x) => x.result);
}

// Usernames: letters (Thai or English), digits, _ . - ; 2-24 chars; compared lower-case.
function normUser(u) {
  const s = String(u || "").trim().toLowerCase();
  return /^[\p{L}\p{N}_.-]{2,24}$/u.test(s) ? s : null;
}
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString("hex");
}
function safeEqual(a, b) {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function newSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  await kv(["SET", "session:" + token, username, "EX", String(SESSION_DAYS * 86400)]);
  return token;
}
function tokenOf(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer ([a-f0-9]{64})$/.exec(h);
  return m ? m[1] : null;
}
// Returns the username for this request's session, or null.
async function userOf(req) {
  const t = tokenOf(req);
  if (!t) return null;
  const u = await kv(["GET", "session:" + t]);
  return u || null;
}
async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise((ok) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { ok({}); } });
  });
}
function send(res, code, obj) {
  res.setHeader("Cache-Control", "no-store");
  res.status(code).json(obj);
}

module.exports = { configured, kv, pipeline, normUser, hashPin, safeEqual, newSession, tokenOf, userOf, body, send };
