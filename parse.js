/* Reads the text that Tesseract finds in a Dime screenshot and turns it into
   order or dividend fields. Pure functions: no DOM, so they can be tested in Node. */
(function (root) {
  "use strict";

  const MONTHS = { "มค": 1, "กพ": 2, "มีค": 3, "เมย": 4, "พค": 5, "มิย": 6, "กค": 7, "สค": 8, "กย": 9, "ตค": 10, "พย": 11, "ธค": 12 };
  const STOP = new Set(["USD", "THB", "VAT", "HKD", "CNY", "JPY", "EUR", "GBP", "SGD", "ETF", "KKP", "DIME", "XD", "WHT", "ID", "OK", "AM", "PM", "TH", "US"]);
  const CCYS = ["USD", "THB", "HKD", "CNY", "JPY", "EUR", "GBP", "SGD"];

  const toNum = (s) => {
    const n = parseFloat(String(s).replace(/[,\s]/g, ""));
    return isFinite(n) ? n : NaN;
  };
  const decimals = (s) => {
    const m = String(s).match(/\.(\d+)/);
    return m ? m[1].length : 0;
  };

  /* Thai month: keep consonants plus เ ี ิ so ม.ค. (Jan) and มี.ค. (Mar) stay apart;
     drop dots, spaces and stray marks that OCR adds (for example "ก.ุย."). */
  function monthOf(raw) {
    const k = String(raw).replace(/[^ก-ฮเีิ]/g, "");
    if (MONTHS[k]) return MONTHS[k];
    const bare = k.replace(/[ีิ]/g, "");
    const hit = Object.keys(MONTHS).find((m) => m.replace(/[ีิ]/g, "") === bare && m.length === k.length);
    return hit ? MONTHS[hit] : 0;
  }

  /* All dates in the text, in order, as YYYY-MM-DD (Gregorian). */
  function findDates(text) {
    const out = [];
    const re = /(\d{1,2})\s*([ก-๙][ก-๙.\s]{1,8}?)\s*(\d{4}|\d{2})(?!\d)/g;
    let m;
    while ((m = re.exec(text))) {
      const d = +m[1], mo = monthOf(m[2]);
      let y = +m[3];
      if (!mo || d < 1 || d > 31) continue;
      if (y < 100) y = 2500 + y;      // 68 -> 2568
      if (y > 2400) y -= 543;          // Buddhist Era -> Gregorian
      if (y < 1990 || y > 2100) continue;
      out.push(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    const iso = /(20\d{2})-(\d{2})-(\d{2})/g;
    while ((m = iso.exec(text))) out.push(m[0]);
    return out;
  }

  /* Amounts followed by a currency code, e.g. "610.68 USD". */
  function amounts(text) {
    const out = [];
    const re = /(-?[\d][\d,]*\.?\d*)\s*(USD|THB|HKD|CNY|JPY|EUR|GBP|SGD)\b/g;
    let m;
    while ((m = re.exec(text))) {
      const v = toNum(m[1]);
      if (isFinite(v)) out.push({ v, cur: m[2], raw: m[1], at: m.index });
    }
    return out;
  }

  function fxOf(text) {
    const m = text.match(/1\s*(USD|HKD|CNY|JPY|EUR|GBP|SGD)\s*[=:]\s*([\d,]+\.?\d*)\s*THB/);
    return m ? { cur: m[1], fx: toNum(m[2]) } : null;
  }

  function symbolOf(text) {
    const re = /\b([A-Z]{1,6}(?:\.[A-Z]{1,2})?)\b/g;
    let m;
    while ((m = re.exec(text))) {
      const s = m[1];
      if (STOP.has(s) || s.length < 2 && !/^[A-Z]$/.test(s)) continue;
      if (s.length === 1) continue;
      return s;
    }
    return null;
  }

  function sideOf(text) {
    const sell = /ขาย/.test(text) && !/ค่าขาย/.test(text);
    const buy = /ซ[ืิ]?[้]?อ|ซื้อ/.test(text);
    if (sell && !buy) return "sell";
    if (buy && !sell) return "buy";
    return null;
  }

  /* Order confirmation: price per share, shares, rate, date. Price × shares must match a
     total on the screen, which keeps us from mixing up the per-share price and the total. */
  function parseOrder(text) {
    const t = String(text || "");
    const fx = fxOf(t);
    const body = t.replace(/1\s*(USD|HKD|CNY|JPY|EUR|GBP|SGD)\s*[=:]\s*[\d,]+\.?\d*\s*THB/g, " ");
    const amts = amounts(body);
    const nums = (body.match(/\d[\d,]*\.\d+/g) || []).map((raw) => ({ raw, v: toNum(raw), dec: decimals(raw) })).filter((x) => x.v > 0);
    let cur = fx ? fx.cur : amts.some((a) => a.cur !== "THB") ? amts.find((a) => a.cur !== "THB").cur : "THB";
    const priced = amts.filter((a) => a.cur === cur && a.v > 0);

    let best = null;
    for (const p of priced) {
      for (const q of nums) {
        if (q.v === p.v) continue;
        const prod = p.v * q.v;
        for (const tot of priced) {
          if (tot === p || tot.v <= 0) continue;
          const err = Math.abs(prod - tot.v) / tot.v;
          if (err < 0.006 && (!best || err < best.err)) best = { price: p.v, qty: q.v, total: tot.v, err };
        }
      }
    }
    let price = best ? best.price : priced.length ? priced[0].v : null;
    let qty = best ? best.qty : null;
    if (!qty) {
      const q = nums.filter((n) => !amts.some((a) => a.v === n.v)).sort((a, b) => b.dec - a.dec)[0];
      qty = q ? q.v : null;
    }
    const thb = amts.filter((a) => a.cur === "THB" && a.v > 0).map((a) => a.v);
    const totalThb = thb.length ? Math.max(...thb) : null;
    let rate = cur === "THB" ? 1 : fx ? fx.fx : null;
    if (!price && totalThb && qty && rate) price = totalThb / rate / qty;
    const dates = findDates(t);
    return {
      side: sideOf(t),
      symbol: symbolOf(t),
      cur,
      price: price || null,
      qty: qty || null,
      fx: rate || null,
      date: dates.length ? dates[dates.length - 1] : null,
    };
  }

  /* Dividend slip: symbol, net amount received, date. Prefers a baht amount; a foreign
     amount is converted when the screen shows a rate. */
  function parseDividend(text) {
    const t = String(text || "");
    const fx = fxOf(t);
    const amts = amounts(t.replace(/1\s*(USD|HKD|CNY|JPY|EUR|GBP|SGD)\s*[=:]\s*[\d,]+\.?\d*\s*THB/g, " ")).filter((a) => a.v > 0);
    const thb = amts.filter((a) => a.cur === "THB");
    const fore = amts.filter((a) => a.cur !== "THB");
    let amountThb = null, amountNative = null, cur = null;
    if (thb.length) amountThb = thb[thb.length - 1].v;
    if (fore.length) { amountNative = fore[fore.length - 1].v; cur = fore[fore.length - 1].cur; }
    if (!amountThb && amountNative && fx) amountThb = amountNative * fx.fx;
    const dates = findDates(t);
    return {
      symbol: symbolOf(t),
      cur: cur || "THB",
      amountThb,
      amountNative,
      fx: fx ? fx.fx : null,
      date: dates.length ? dates[dates.length - 1] : null,
    };
  }

  const api = { parseOrder, parseDividend, findDates, monthOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.DimeParse = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
