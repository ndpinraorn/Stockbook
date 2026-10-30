// GET /api/dividends?symbols=AAPL,NVDA,PTT&th=PTT
// Returns each symbol's dividend history (ex-dividend date and amount per share)
// from Yahoo Finance's public chart data. Thai symbols listed in `th` are looked
// up with the ".BK" suffix. Responses are cached at Vercel's edge for 12 hours.

const SYMBOL_RE = /^[A-Z0-9.\-]{1,15}$/;

function list(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => SYMBOL_RE.test(s));
}

async function history(symbol, yahooSymbol) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol) +
    "?range=5y&interval=1mo&events=div";
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (stockbook)" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const x = j && j.chart && j.chart.result && j.chart.result[0];
  if (!x) throw new Error("no data");
  const off = (x.meta && x.meta.gmtoffset) || 0;
  const events = Object.values((x.events && x.events.dividends) || {})
    .map((d) => ({
      date: new Date((d.date + off) * 1000).toISOString().slice(0, 10),
      amount: Math.round(d.amount * 1e6) / 1e6,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { currency: (x.meta && x.meta.currency) || null, events };
}

module.exports = async (req, res) => {
  const symbols = list(req.query.symbols).slice(0, 40);
  const thai = new Set(list(req.query.th));
  if (!symbols.length) {
    res.status(400).json({ error: "Pass ?symbols=AAPL,PTT" });
    return;
  }
  const out = {};
  await Promise.all(
    symbols.map(async (s) => {
      const y = thai.has(s) && !s.endsWith(".BK") ? s + ".BK" : s;
      try {
        out[s] = await history(s, y);
      } catch (e) {
        out[s] = { error: "not_found" };
      }
    })
  );
  res.setHeader("Cache-Control", "s-maxage=43200, stale-while-revalidate=86400");
  res.status(200).json(out);
};
