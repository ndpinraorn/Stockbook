// POST /api/auth  { action: "register" | "login" | "logout", username, pin }
// A simple username + PIN login. PINs are stored as salted scrypt hashes, never as text.
// After 8 wrong PINs an account is locked for 15 minutes.

const crypto = require("crypto");
const L = require("./_lib");

const MAX_FAILS = 8, LOCK_SECONDS = 900;

module.exports = async (req, res) => {
  if (req.method !== "POST") return L.send(res, 405, { error: "method_not_allowed" });
  if (!L.configured()) return L.send(res, 503, { error: "storage_not_configured" });
  const b = await L.body(req);
  try {
    if (b.action === "logout") {
      const t = L.tokenOf(req);
      if (t) await L.kv(["DEL", "session:" + t]);
      return L.send(res, 200, { ok: true });
    }
    const username = L.normUser(b.username);
    const pin = String(b.pin || "");
    if (!username) return L.send(res, 400, { error: "bad_username" });
    if (!/^\d{4,8}$/.test(pin)) return L.send(res, 400, { error: "bad_pin" });
    const key = "user:" + username;

    if (b.action === "register") {
      const salt = crypto.randomBytes(16).toString("hex");
      const rec = JSON.stringify({ salt, hash: L.hashPin(pin, salt), createdAt: Date.now() });
      const ok = await L.kv(["SET", key, rec, "NX"]);
      if (!ok) return L.send(res, 409, { error: "username_taken" });
      return L.send(res, 200, { token: await L.newSession(username), username });
    }

    if (b.action === "login") {
      const failKey = "fail:" + username;
      const fails = +(await L.kv(["GET", failKey])) || 0;
      if (fails >= MAX_FAILS) return L.send(res, 429, { error: "locked" });
      const raw = await L.kv(["GET", key]);
      const rec = raw ? JSON.parse(raw) : null;
      if (!rec || !L.safeEqual(L.hashPin(pin, rec.salt), rec.hash)) {
        await L.pipeline([["INCR", failKey], ["EXPIRE", failKey, String(LOCK_SECONDS)]]);
        return L.send(res, 401, { error: "wrong_login", left: Math.max(0, MAX_FAILS - fails - 1) });
      }
      await L.kv(["DEL", failKey]);
      return L.send(res, 200, { token: await L.newSession(username), username });
    }

    return L.send(res, 400, { error: "bad_action" });
  } catch (e) {
    return L.send(res, 500, { error: "server_error" });
  }
};
