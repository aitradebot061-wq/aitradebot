/* Track record: pairing + stats (mirrors bot/track_record.py) and in-browser verification.
   Pure functions are exported for Node tests; the render code runs only in a browser. */
(function (root) {
  "use strict";
  var SIDE_SIGN = { BUY: 1, COVER: 1, SELL: -1, SHORT: -1 };
  var EPS = 1e-9;

  function buildTrips(fills, feeRate) {
    var trips = [], book = {};
    fills.forEach(function (f) {
      var seq = f.seq, t = f.trade;
      var sign = SIDE_SIGN[String(t.side || "").toUpperCase()];
      var qty = Number(t.qty || 0), price = Number(t.price || 0);
      if (sign === undefined || !(qty > 0) || !(price > 0)) return;
      var hasFee = Object.prototype.hasOwnProperty.call(t, "fee");
      var feeTotal = hasFee ? Number(t.fee) : qty * price * feeRate;
      var key = t.market + "|" + t.symbol, remaining = qty;
      while (remaining > EPS) {
        var cur = book[key];
        if (!cur) {
          cur = { market: t.market, symbol: t.symbol, dir: sign > 0 ? "long" : "short", pos: 0, seqs: [],
                  open_ts: t.ts, close_ts: null, entry_notional: 0, cash: 0, fees: 0, estimated_fees: false };
          book[key] = cur; trips.push(cur);
        }
        var opening = (cur.pos >= 0) === (sign > 0) || Math.abs(cur.pos) < EPS;
        var part = opening ? remaining : Math.min(remaining, Math.abs(cur.pos));
        if (cur.seqs.indexOf(seq) < 0) cur.seqs.push(seq);
        cur.pos += sign * part;
        cur.cash -= sign * part * price;
        cur.fees += feeTotal * part / qty;
        cur.estimated_fees = cur.estimated_fees || !hasFee;
        if (opening) cur.entry_notional += part * price;
        remaining -= part;
        if (Math.abs(cur.pos) < EPS * Math.max(1, qty)) {
          cur.pos = 0; cur.close_ts = t.ts;
          cur.pnl_net = cur.cash - cur.fees;
          cur.return_pct = 100 * cur.pnl_net / cur.entry_notional;
          delete book[key];
        }
      }
    });
    trips.forEach(function (tr) { delete tr.cash; });
    return trips;
  }

  function summarize(trips) {
    var closed = trips.filter(function (t) { return t.close_ts; })
      .sort(function (a, b) { return Date.parse(a.close_ts) - Date.parse(b.close_ts); });
    var rets = closed.map(function (t) { return t.return_pct; });
    var wins = rets.filter(function (r) { return r > 0; }), losses = rets.filter(function (r) { return r <= 0; });
    var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
    var cum = 0, peak = 0, mdd = 0, curve = [];
    closed.forEach(function (t) { cum += t.return_pct; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); curve.push({ ts: t.close_ts, cum: cum }); });
    return {
      trades: rets.length, wins: wins.length, losses: losses.length,
      win_rate_pct: rets.length ? 100 * wins.length / rets.length : null,
      cumulative_pct: cum,
      avg_win_pct: wins.length ? sum(wins) / wins.length : null,
      avg_loss_pct: losses.length ? sum(losses) / losses.length : null,
      max_drawdown_pct: mdd,
      profit_factor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
      curve: curve
    };
  }

  var api = { buildTrips: buildTrips, summarize: summarize };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  root.TrackRecord = api;

  /* ---------------- browser: verify + render ---------------- */
  var TOPIC_ANCHOR = "0x34bf3df7ae258af28d69cf54076a2d22c68a6a140644530c8708ae0556745835";
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function hexToBytes(h) { h = h.replace(/^0x/, ""); var b = new Uint8Array(h.length / 2); for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
  function bytesToHex(b) { return "0x" + Array.prototype.map.call(new Uint8Array(b), function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function sha256Hex(str) { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(bytesToHex); }
  function chainHead(hashes) {
    var head = new Uint8Array(32);
    hashes.forEach(function (h) { var buf = new Uint8Array(64); buf.set(head, 0); buf.set(hexToBytes(h), 32); head = new Uint8Array(root.keccak256.arrayBuffer(buf)); });
    return bytesToHex(head);
  }
  function selector(sig) { return "0x" + root.keccak256(sig).slice(0, 8); }
  function pad(addr) { return "000000000000000000000000" + addr.replace(/^0x/, "").toLowerCase(); }
  function pct(v, signed) { if (v === null || v === undefined || isNaN(v)) return "—"; return (signed && v > 0 ? "+" : "") + v.toFixed(2) + "%"; }
  function fmtTime(ts) { return String(ts).replace("T", " ").replace("Z", " UTC"); }

  function setCheck(id, state, text) { var e = $(id); e.className = "chk " + state; e.textContent = text; }

  function renderChart(curve) {
    var box = $("tr-chart"); box.innerHTML = "";
    if (curve.length < 2) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    var W = 640, H = 180, P = 8;
    var pts = [{ cum: 0 }].concat(curve), vals = pts.map(function (p) { return p.cum; });
    var lo = Math.min(0, Math.min.apply(null, vals)), hi = Math.max(0, Math.max.apply(null, vals));
    if (hi - lo < 1e-9) hi = lo + 1;
    var x = function (i) { return P + i * (W - 2 * P) / (pts.length - 1); };
    var y = function (v) { return P + (hi - v) * (H - 2 * P) / (hi - lo); };
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.cum).toFixed(1); }).join(" ");
    var last = vals[vals.length - 1];
    box.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="Cumulative per-trade return, ' + pct(last, true) + '">' +
      '<line x1="' + P + '" x2="' + (W - P) + '" y1="' + y(0) + '" y2="' + y(0) + '" class="zero"/>' +
      '<path d="' + d + '" class="' + (last >= 0 ? "up" : "down") + '"/></svg>';
  }

  function renderTable(fills, trips, data) {
    var closeRet = {};
    trips.forEach(function (t) { if (t.close_ts) closeRet[t.seqs[t.seqs.length - 1]] = t; });
    var tb = $("tr-rows"); tb.innerHTML = "";
    fills.slice().reverse().forEach(function (f) {
      var t = f.trade, tr = el("tr"), trip = closeRet[f.seq];
      tr.appendChild(el("td", "mono", "#" + f.seq));
      tr.appendChild(el("td", "mono", fmtTime(t.ts)));
      tr.appendChild(el("td", "", t.symbol));
      var side = el("td", "side " + (SIDE_SIGN[t.side] > 0 ? "buy" : "sell"), t.side); tr.appendChild(side);
      tr.appendChild(el("td", "mono", String(t.price)));
      var r = el("td", "mono " + (trip ? (trip.return_pct > 0 ? "pos" : "neg") : ""), trip ? pct(trip.return_pct, true) : "");
      tr.appendChild(r);
      var v = el("td", "mono"); var a = el("a", f.ok ? "ok" : "bad", f.ok ? "✓ tx" : "✕ mismatch");
      a.href = data.explorer + "/tx/" + f.tx_hash; a.target = "_blank"; a.rel = "noopener"; v.appendChild(a); tr.appendChild(v);
      tb.appendChild(tr);
    });
  }

  function load(cfg) {
    fetch("data/track-record.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("no snapshot"); return r.json(); })
      .then(function (data) { return render(cfg, data); })
      .catch(function (e) { $("tr-status").textContent = "No track record published yet."; if (root.console) console.error("[track-record]", e); });
  }

  function render(cfg, data) {
    var anchors = data.anchors || [];
    var count = function (s) { return anchors.filter(function (a) { return a.status === s; }).length; };
    $("tr-updated").textContent = "Snapshot " + new Date(data.generated_at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC · " + data.anchor_count + " anchors · reveal delay " + data.delay_hours + "h";
    $("tr-pending").textContent = count("open") + " open, " + count("delayed") + " closed less than " + data.delay_hours + "h ago (hash only, details later)" +
      (count("withheld") ? ", " + count("withheld") + " non-crypto (hash only)" : "");

    var withCanon = anchors.filter(function (a) { return a.canon; });
    return Promise.all(withCanon.map(function (a) { return sha256Hex(a.canon).then(function (h) { a.ok = h === a.trade_hash; }); }))
      .then(function () {
        var bad = withCanon.filter(function (a) { return !a.ok; }).length;
        setCheck("tr-c-hash", bad ? "bad" : "ok", withCanon.length ? (bad ? bad + " of " + withCanon.length + " records do NOT match their hash" : "All " + withCanon.length + " published records match their anchored hash") : "No revealed records yet");
        var seqOk = anchors.every(function (a, i) { return a.seq === i + 1; });
        var localHead = root.keccak256 ? chainHead(anchors.map(function (a) { return a.trade_hash; })) : null;
        var fills = anchors.filter(function (a) { return a.status === "revealed"; })
          .map(function (a) { return { seq: a.seq, trade: JSON.parse(a.canon), tx_hash: a.tx_hash, ok: a.ok }; });
        var trips = buildTrips(fills, data.fee_rate).filter(function (t) { return t.close_ts; });
        var s = summarize(trips);
        $("tr-n").textContent = s.trades;
        $("tr-win").textContent = pct(s.win_rate_pct);
        $("tr-cum").textContent = pct(s.cumulative_pct, true);
        $("tr-cum").className = "v " + (s.cumulative_pct > 0 ? "pos" : s.cumulative_pct < 0 ? "neg" : "");
        $("tr-mdd").textContent = s.trades ? "-" + s.max_drawdown_pct.toFixed(2) + "%" : "—";
        $("tr-avg").textContent = pct(s.avg_win_pct, true) + " / " + pct(s.avg_loss_pct, true);
        $("tr-pf").textContent = s.profit_factor === null ? "—" : s.profit_factor.toFixed(2);
        $("tr-fees").textContent = trips.some(function (t) { return t.estimated_fees; }) ? "Fees estimated at " + (data.fee_rate * 100).toFixed(2) + "% per side where the record carries none." : "Fees as recorded.";
        renderChart(s.curve);
        if (fills.length) { $("tr-table").classList.remove("hidden"); renderTable(fills, trips, data); }
        var st = $("tr-status");
        st.textContent = s.trades ? "" : "No closed live trades revealed yet. Each position appears here " + data.delay_hours + " hours after it closes.";
        st.classList.toggle("hidden", !!s.trades);
        return verifyChain(cfg, data, anchors, seqOk, localHead);
      });
  }

  function rpc(cfg, method, params) {
    return fetch(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }) })
      .then(function (r) { return r.json(); }).then(function (j) { if (j.error) throw j.error; return j.result; });
  }

  function verifyChain(cfg, data, anchors, seqOk, localHead) {
    if (!localHead) { setCheck("tr-c-chain", "warn", "Hash library unavailable; chain not checked"); return; }
    if (!seqOk || localHead !== data.anchor_head) { setCheck("tr-c-chain", "bad", "Published hash list is inconsistent (sequence gap or head mismatch)"); return; }
    if (!data.agent) return;
    var callData = function (sig) { return selector(sig) + pad(data.agent); };
    return Promise.all([
      rpc(cfg, "eth_call", [{ to: data.contract, data: callData("anchorHead(address)") }, "latest"]),
      rpc(cfg, "eth_call", [{ to: data.contract, data: callData("agents(address)") }, "latest"])
    ]).then(function (r) {
      var head = r[0].toLowerCase(), onCount = parseInt(r[1].slice(2 + 64 * 9, 2 + 64 * 10), 16);
      if (onCount === data.anchor_count) {
        setCheck("tr-c-chain", head === localHead ? "ok" : "bad", head === localHead
          ? "Hash chain of all " + onCount + " anchors equals the on-chain anchorHead: nothing dropped, reordered or edited"
          : "On-chain anchorHead does NOT match the published log");
      } else if (onCount < data.anchor_count) {
        setCheck("tr-c-chain", "bad", "Published log lists " + data.anchor_count + " anchors but only " + onCount + " exist on-chain");
      } else {
        setCheck("tr-c-chain", "warn", (onCount - data.anchor_count) + " newer anchor(s) on-chain since this snapshot. Use the receipt check below for the published ones.");
      }
    }).catch(function (e) { setCheck("tr-c-chain", "warn", "Could not reach BNB Chain RPC: " + (e.message || e)); });
  }

  function verifyReceipts(cfg) {
    var btn = $("tr-receipts"); btn.disabled = true;
    fetch("data/track-record.json", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (data) {
      var list = data.anchors.slice(), done = 0, bad = [];
      var agentTopic = "0x" + pad(data.agent);
      function next() {
        var a = list.shift(); if (!a) return Promise.resolve();
        return rpc(cfg, "eth_getTransactionReceipt", [a.tx_hash]).then(function (rc) {
          var hit = (rc && rc.logs || []).some(function (lg) {
            return lg.address.toLowerCase() === data.contract.toLowerCase() && lg.topics[0] === TOPIC_ANCHOR &&
              lg.topics[1].toLowerCase() === agentTopic && parseInt(lg.topics[2], 16) === a.seq && lg.data.slice(0, 66).toLowerCase() === a.trade_hash;
          });
          if (!hit) bad.push(a.seq);
        }).catch(function () { bad.push(a.seq); }).then(function () { done++; btn.textContent = "Checking " + done + " / " + data.anchors.length; return next(); });
      }
      return Promise.all([next(), next(), next(), next()]).then(function () {
        setCheck("tr-c-rcpt", bad.length ? "bad" : "ok", bad.length ? "Not found on-chain: #" + bad.slice(0, 10).join(", #") : "Every published anchor found in its BNB Chain transaction at the right sequence number");
        btn.textContent = "Check again"; btn.disabled = false;
      });
    });
  }

  root.TrackRecord.load = load;
  root.TrackRecord.verifyReceipts = verifyReceipts;
})(typeof window !== "undefined" ? window : this);
