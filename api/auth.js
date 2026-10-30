// POST /api/auth
//   { action: "google", credential }        → sign in with Google; returns { token, user, email, name, picture }
//   { action: "link", username, pin }        → (signed in with Google) move data from an old username+PIN account
//   { action: "logout" }
// Accounts are keyed "g:<google sub>". Old PIN accounts can no longer sign in; they can only be linked once.

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

    if (b.action === "google") {
      const g = await L.verifyGoogle(b.credential);
      if (!g) return L.send(res, 401, { error: "google_invalid" });
      const uid = "g:" + g.sub;
      const profile = { email: g.email, name: g.name, picture: g.picture };
      await L.kv(["SET", "profile:" + uid, JSON.stringify({ ...profile, lastLogin: Date.now() })]);
      const token = await L.newSession(uid);
      return L.send(res, 200, { token, user: uid, ...profile });
    }

    if (b.action === "link") {
      const me = await L.userOf(req);
      if (!me || !me.startsWith("g:")) return L.send(res, 401, { error: "not_signed_in" });
      const username = L.normUser(b.username);
      const pin = String(b.pin || "");
      if (!username || !/^\d{4,8}$/.test(pin)) return L.send(res, 400, { error: "wrong_login" });
      const failKey = "fail:" + username;
      const fails = +(await L.kv(["GET", failKey])) || 0;
      if (fails >= MAX_FAILS) return L.send(res, 429, { error: "locked" });
      const raw = await L.kv(["GET", "user:" + username]);
      const rec = raw ? JSON.parse(raw) : null;
      if (!rec || !L.safeEqual(L.hashPin(pin, rec.salt), rec.hash)) {
        await L.pipeline([["INCR", failKey], ["EXPIRE", failKey, String(LOCK_SECONDS)]]);
        return L.send(res, 401, { error: "wrong_login", left: Math.max(0, MAX_FAILS - fails - 1) });
      }
      await L.kv(["DEL", failKey]);
      if (rec.linkedTo && rec.linkedTo !== me) return L.send(res, 409, { error: "already_linked" });

      // copy every record that the Google account doesn't already have
      const flat = (await L.kv(["HGETALL", "data:" + username])) || [];
      const mine = new Set(((await L.kv(["HKEYS", "data:" + me])) || []));
      const cmds = [];
      let lots = 0, divs = 0;
      for (let i = 0; i < flat.length; i += 2) {
        const f = flat[i];
        if (mine.has(f)) continue;
        cmds.push(["HSET", "data:" + me, f, flat[i + 1]]);
        if (f.startsWith("lot:")) lots++;
        else if (f.startsWith("div:")) divs++;
      }
      cmds.push(["SET", "user:" + username, JSON.stringify({ ...rec, linkedTo: me, linkedAt: Date.now() })]);
      await L.pipeline(cmds);
      return L.send(res, 200, { ok: true, lots, divs });
    }

    return L.send(res, 400, { error: "bad_action" });
  } catch (e) {
    return L.send(res, 500, { error: "server_error" });
  }
};
