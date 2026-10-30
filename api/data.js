// GET  /api/data            → { username, lots, divs, rates }
// POST /api/data { ops: [] } → apply changes, one item at a time, so two devices never
// overwrite each other's whole notebook. Ops:
//   { op: "putLot", lot }   { op: "delLot", id }
//   { op: "putDiv", div }   { op: "delDiv", id }
//   { op: "rates", rates }  { op: "import", lots, divs, rates }  (replaces everything)
// Everything for one user lives in the Redis hash  data:<username>.

const L = require("./_lib");

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_ITEM = 4000; // bytes per stored record

function clean(obj) {
  if (!obj || typeof obj !== "object" || !ID_RE.test(String(obj.id || ""))) return null;
  const s = JSON.stringify(obj);
  return s.length <= MAX_ITEM ? s : null;
}

module.exports = async (req, res) => {
  if (!L.configured()) return L.send(res, 503, { error: "storage_not_configured" });
  try {
    const username = await L.userOf(req);
    if (!username) return L.send(res, 401, { error: "not_signed_in" });
    const key = "data:" + username;

    if (req.method === "GET") {
      const flat = (await L.kv(["HGETALL", key])) || [];
      const lots = [], divs = [];
      let rates = {};
      for (let i = 0; i < flat.length; i += 2) {
        const f = flat[i];
        let v;
        try { v = JSON.parse(flat[i + 1]); } catch (e) { continue; }
        if (f.startsWith("lot:")) lots.push(v);
        else if (f.startsWith("div:")) divs.push(v);
        else if (f === "rates") rates = v || {};
      }
      return L.send(res, 200, { username, lots, divs, rates });
    }

    if (req.method === "POST") {
      const b = await L.body(req);
      const ops = Array.isArray(b.ops) ? b.ops.slice(0, 500) : [];
      const cmds = [];
      for (const o of ops) {
        if (o.op === "putLot") { const s = clean(o.lot); if (s) cmds.push(["HSET", key, "lot:" + o.lot.id, s]); }
        else if (o.op === "delLot" && ID_RE.test(String(o.id))) cmds.push(["HDEL", key, "lot:" + o.id]);
        else if (o.op === "putDiv") { const s = clean(o.div); if (s) cmds.push(["HSET", key, "div:" + o.div.id, s]); }
        else if (o.op === "delDiv" && ID_RE.test(String(o.id))) cmds.push(["HDEL", key, "div:" + o.id]);
        else if (o.op === "rates" && o.rates && typeof o.rates === "object") cmds.push(["HSET", key, "rates", JSON.stringify(o.rates).slice(0, 2000)]);
        else if (o.op === "import") {
          cmds.push(["DEL", key]);
          for (const l of (o.lots || []).slice(0, 3000)) { const s = clean(l); if (s) cmds.push(["HSET", key, "lot:" + l.id, s]); }
          for (const d of (o.divs || []).slice(0, 3000)) { const s = clean(d); if (s) cmds.push(["HSET", key, "div:" + d.id, s]); }
          if (o.rates) cmds.push(["HSET", key, "rates", JSON.stringify(o.rates).slice(0, 2000)]);
        }
      }
      await L.pipeline(cmds);
      return L.send(res, 200, { ok: true, applied: cmds.length });
    }

    return L.send(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    return L.send(res, 500, { error: "server_error" });
  }
};
