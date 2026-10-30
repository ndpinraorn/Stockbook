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

  /* Labels as OCR tends to read them: tone marks and vowels may be dropped or swapped
     ("ราคาที่ได้อริง"), so match loosely on the stable consonants. */
  const PRICE_LBL = /ราคา\s*ท\S{0,3}\s*ได\S{0,2}\s*[จอ]\S{0,3}ง/;
  const QTY_LBL = /จ\S{0,2}นวน\s*หุ/;
  function numsIn(line) {
    return (line.match(/\d[\d,]*\.?\d*/g) || []).map((raw) => ({ raw, v: toNum(raw), dec: decimals(raw) })).filter((x) => x.v > 0);
  }
  function anchored(text) {
    const lines = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const out = { price: null, qty: null };
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (PRICE_LBL.test(L)) {
        // value either after the label on the same line, or on the next line
        const after = L.split(PRICE_LBL)[1] || "";
        const sameQtyLbl = QTY_LBL.test(L);
        let cand = numsIn(after.split(QTY_LBL)[0]);
        let src = cand.length ? after : lines[i + 1] || "";
        if (!cand.length) cand = numsIn(src);
        if (cand.length) {
          out.price = cand[0].v;
          if (sameQtyLbl && cand.length > 1) out.qty = cand[1].v;
        }
      } else if (!out.qty && QTY_LBL.test(L) && !PRICE_LBL.test(L)) {
        const after = numsIn(L.split(QTY_LBL)[1] || "");
        if (after.length) out.qty = after[0].v;
        else {
          // label in the right-hand column → take the right-hand number on the next row
          const n = numsIn(lines[i + 1] || "");
          const rightCol = /\S/.test(L.split(QTY_LBL)[0]);
          if (n.length) out.qty = (rightCol ? n[n.length - 1] : n[0]).v;
        }
      }
    }
    return out;
  }

  /* Real money moved, fees included: "ยอดที่จะได้รับคืน" on a sell, the amount paid on a
     buy. Also "มูลค่าหุ้น" (shares × price) as a cross-check. Value on the same line or the next. */
  const NET_SELL = /ได\S{0,2}\s*รับ\s*ค\S{0,2}น/;
  const NET_BUY = /(ยอด\s*ท\S{0,3}\s*ต\S{0,2}อง\s*(ชำ|ช\S{0,2}ระ|จ\S{0,2}าย)|ยอด\s*ชำระ|ยอด\s*รวม|ยอด\s*ที่\s*ชำระ|ยอด\s*ที่\s*จ\S{0,2}าย)/;
  const GROSS = /มูลค\S{0,2}า\s*หุ/;
  function labelled(text, re) {
    const lines = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const after = numsIn(lines[i].split(re).pop() || "");
      const n = after.length ? after : numsIn(lines[i + 1] || "");
      if (n.length) return n[0].v;
    }
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
    /* Dime puts the executed price under the label "ราคาที่ได้จริง" (and the share count
       under "จำนวนหุ้น" on the same row). Values read from those labels always win. */
    const anc = anchored(body);
    let price = anc.price || (best ? best.price : priced.length ? priced[0].v : null);
    let qty = anc.qty || (best && (!anc.price || Math.abs(best.price - anc.price) < 1e-9) ? best.qty : null);
    if (anc.price && !anc.qty && !qty) {
      const tot = priced.filter((a) => a.v !== anc.price);
      for (const q of nums) for (const t2 of tot) if (Math.abs(anc.price * q.v - t2.v) / t2.v < 0.006) { qty = q.v; break; }
    }
    if (!qty) {
      const q = nums.filter((n) => !amts.some((a) => a.v === n.v)).sort((a, b) => b.dec - a.dec)[0];
      qty = q ? q.v : null;
    }
    const thb = amts.filter((a) => a.cur === "THB" && a.v > 0).map((a) => a.v);
    const totalThb = thb.length ? Math.max(...thb) : null;
    let rate = cur === "THB" ? 1 : fx ? fx.fx : null;
    if (!price && totalThb && qty && rate) price = totalThb / rate / qty;
    const gross = labelled(body, GROSS);
    if (!qty && gross && price) qty = +(gross / price).toFixed(7);
    const side = sideOf(t);
    let amount = labelled(body, side === "buy" ? NET_BUY : NET_SELL) || (side ? null : labelled(body, NET_SELL));
    const ref = price && qty ? price * qty : gross;
    if (amount && ref && Math.abs(amount - ref) / ref > 0.03) amount = null;
    const dates = findDates(t);
    return {
      amount: amount || null,
      side,
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
