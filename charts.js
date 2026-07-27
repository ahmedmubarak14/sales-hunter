/* ============================================================
   Sales Hunter — chart engine
   Dependency-free inline SVG. Colors come from CSS classes so
   light/dark themes restyle charts without re-rendering.
   Every chart card ships a table-view twin (the "Data" toggle)
   and per-mark hover tooltips.
   ============================================================ */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// tallyReasons() (data.js) buckets deals with no reason captured under
// NO_REASON_KEY rather than dropping them — this is where that bucket
// gets a real, translated label instead of the raw sentinel key.
function reasonLabel(k) { return k === NO_REASON_KEY ? t('noReasonGiven') : trReason(k); }

function curr(v) { return isAr() ? v + ' ر.س' : 'SAR ' + v; }
function fmtMoney(n) { return curr(Math.round(n).toLocaleString('en-US')); }
function fmtMoneyC(n) { // compact
  if (Math.abs(n) >= 1e6) return curr((n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M');
  if (Math.abs(n) >= 1e3) return curr((n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K');
  return curr(Math.round(n));
}
function fmtPct(x, dp) { return (x * 100).toFixed(dp === undefined ? 1 : dp) + '%'; }
function fmtDate(d) {
  return d.toLocaleDateString(isAr() ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtNum(n) { return Math.round(n).toLocaleString('en-US'); }

/* Clean axis ticks: 0..max rounded to a friendly step.
   intOnly forces whole-number steps (count axes), so gridline labels
   are never rounded into lying positions. */
function niceTicks(maxVal, count, intOnly) {
  if (maxVal <= 0) maxVal = 1;
  var rough = maxVal / count;
  var mag = Math.pow(10, Math.floor(Math.log10(rough)));
  var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; })
    .find(function (s) { return s >= rough; }) || 10 * mag;
  if (intOnly) step = Math.max(1, Math.round(step));
  var ticks = [];
  for (var v = 0; v <= maxVal + step * 0.999; v += step) ticks.push(v);
  return ticks;
}

/* Horizontal bar path: rounded only on the requested ends (data end
   rounded, baseline end square — per the mark spec). */
function hbarPath(x, y, w, h, roundLeft, roundRight) {
  var r = Math.min(4, w / 2, h / 2);
  var tl = roundLeft ? r : 0, tr = roundRight ? r : 0;
  return 'M' + (x + tl) + ' ' + y +
    ' H' + (x + w - tr) +
    (tr ? ' Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + tr) : '') +
    ' V' + (y + h - tr) +
    (tr ? ' Q' + (x + w) + ' ' + (y + h) + ' ' + (x + w - tr) + ' ' + (y + h) : '') +
    ' H' + (x + tl) +
    (tl ? ' Q' + x + ' ' + (y + h) + ' ' + x + ' ' + (y + h - tl) : '') +
    ' V' + (y + tl) +
    (tl ? ' Q' + x + ' ' + y + ' ' + (x + tl) + ' ' + y : '') + ' Z';
}

/* ---- Shared tooltip ---- */
function initTooltip(root) {
  var tip = document.getElementById('viz-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'viz-tip';
    tip.setAttribute('role', 'status');
    document.body.appendChild(tip);
  }
  root.addEventListener('mousemove', function (e) {
    var el = e.target.closest('[data-tip]');
    if (el) {
      tip.innerHTML = el.getAttribute('data-tip');
      tip.style.display = 'block';
      var x = e.clientX + 14, y = e.clientY + 14;
      var r = tip.getBoundingClientRect();
      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 10;
      if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 10;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    } else {
      tip.style.display = 'none';
    }
  });
  root.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
}

/* ---- Chart card wrapper with chart/table toggle ---- */
var cardSeq = 0;
function chartCard(opts) {
  // opts: {title, subtitle, legend:[{cls,label}], svg, table:{head:[], rows:[[]]}, minH}
  cardSeq += 1;
  var id = 'cc' + cardSeq;
  var legend = '';
  if (opts.legend && opts.legend.length) {
    legend = '<div class="legend">' + opts.legend.map(function (l) {
      return '<span class="lg"><i class="sw ' + l.cls + '"></i>' + esc(l.label) + '</span>';
    }).join('') + '</div>';
  }
  var table = '';
  if (opts.table) {
    table = '<div class="tbl-wrap"><table class="mini"><thead><tr>' +
      opts.table.head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      opts.table.rows.map(function (r) {
        return '<tr>' + r.map(function (c, i) {
          return '<td' + (i > 0 ? ' class="num"' : '') + '>' + esc(c) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  return '<section class="card chart-card" id="' + id + '">' +
    '<div class="card-head">' +
      '<div><h3>' + esc(opts.title) + '</h3>' +
      (opts.subtitle ? '<p class="sub">' + esc(opts.subtitle) + '</p>' : '') + '</div>' +
      (opts.table ? '<button class="ghost-btn" data-toggle-table="' + id + '" aria-pressed="false">' + t('dataBtn') + '</button>' : '') +
    '</div>' +
    legend +
    '<div class="chart-view">' + opts.svg + '</div>' +
    '<div class="table-view" hidden>' + table + '</div>' +
  '</section>';
}

/* ---- Reason breakdown: a title card of big-number tiles, one per
   reason — for "why did leads get lost/unqualified" views. ---- */
// Same tile layout as reasonTilesCard, but each value is pre-formatted by
// the caller, so counts and money can share one card.
function metricTilesCard(title, subtitle, items, cls, emptyText) {
  var body = items.length
    ? '<div class="reason-tiles">' + items.map(function (r) {
        return '<div class="reason-tile"><div class="rt-value ' + (cls || '') + '">' + esc(r.value) + '</div>' +
          '<div class="rt-label">' + esc(r.label) + '</div></div>';
      }).join('') + '</div>'
    : '<div class="empty">' + esc(emptyText || t('noReasonsYet')) + '</div>';
  return '<section class="card">' +
    '<div class="card-head"><div><h3>' + esc(title) + '</h3>' +
    (subtitle ? '<p class="sub">' + esc(subtitle) + '</p>' : '') + '</div></div>' +
    body +
  '</section>';
}

function reasonTilesCard(title, subtitle, items, cls) {
  return metricTilesCard(title, subtitle, items.map(function (r) {
    return { value: fmtNum(r.count), label: r.label };
  }), cls);
}

function wireCardToggles(root) {
  root.querySelectorAll('[data-toggle-table]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var card = document.getElementById(btn.getAttribute('data-toggle-table'));
      var chart = card.querySelector('.chart-view');
      var table = card.querySelector('.table-view');
      var showTable = table.hidden;
      table.hidden = !showTable;
      chart.hidden = showTable;
      btn.setAttribute('aria-pressed', String(showTable));
      btn.textContent = showTable ? t('chartBtn') : t('dataBtn');
    });
  });
}

/* ============================================================
   Chart renderers — each returns an SVG string
   ============================================================ */

/* Funnel: horizontal bars on the ordinal ramp, count at bar end,
   stage-to-stage conversion between rows. */
function funnelSVG(rows) { // rows: [{stage, count}]
  var W = 640, rowH = 44, gap = 14, labelW = 172, valueW = 88, barH = 22;
  var H = rows.length * (rowH + gap) - gap + 8;
  var max = Math.max.apply(null, rows.map(function (r) { return r.count; }).concat([1]));
  var plotW = W - labelW - valueW;
  var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz" role="img" aria-label="Pipeline funnel">';
  rows.forEach(function (r, i) {
    var y = i * (rowH + gap) + 4;
    var w = Math.max(4, (r.count / max) * plotW);
    var pct = i === 0 ? null : (rows[i - 1].count ? r.count / rows[i - 1].count : 0);
    out += '<text x="' + (labelW - 10) + '" y="' + (y + barH / 2 + 4) + '" text-anchor="end" class="ax strong">' + esc(r.stage) + '</text>';
    out += '<path d="' + hbarPath(labelW, y, w, barH, false, true) + '" class="f' + (i + 1) + '" ' +
      'data-tip="<b>' + esc(r.stage) + '</b><br>' + t('leadsReached', { n: fmtNum(r.count) }) +
      (pct !== null ? '<br>' + t('ofPrevStage', { pct: fmtPct(pct, 0) }) : '') + '"></path>';
    out += '<text x="' + (labelW + w + 8) + '" y="' + (y + barH / 2 + 4) + '" class="val">' + fmtNum(r.count) + '</text>';
    if (pct !== null) {
      out += '<text x="' + (labelW - 10) + '" y="' + (y + barH / 2 + 18) + '" text-anchor="end" class="ax dim">' + fmtPct(pct, 0) + ' →</text>';
    }
  });
  return out + '</svg>';
}

/* Vertical columns, single series */
function columnsSVG(labels, values, opts) {
  opts = opts || {};
  var W = 640, H = 230, padL = 46, padB = 26, padT = 12, padR = 8;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var max = Math.max.apply(null, values.concat([1]));
  var ticks = niceTicks(max, 4, !opts.money);
  max = ticks[ticks.length - 1];
  var n = labels.length;
  var slot = plotW / n;
  var bw = Math.min(24, slot * 0.55);
  var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz" role="img" aria-label="' + esc(opts.aria || 'Bar chart') + '">';
  ticks.forEach(function (t) {
    var y = padT + plotH - (t / max) * plotH;
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" class="grid"></line>';
    out += '<text x="' + (padL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end" class="ax">' + (opts.compact ? fmtMoneyC(t).replace('SAR ', '') : fmtNum(t)) + '</text>';
  });
  values.forEach(function (v, i) {
    var h = (v / max) * plotH;
    if (v > 0 && h < 3) h = 3; // clamp before y so tiny values stay visible
    var x = padL + i * slot + (slot - bw) / 2;
    var y = padT + plotH - h;
    if (v > 0) {
      out += '<path d="M' + x + ' ' + (padT + plotH) + ' V' + Math.min(y + 4, padT + plotH) + ' Q' + x + ' ' + y + ' ' + (x + 4) + ' ' + y +
        ' H' + (x + bw - 4) + ' Q' + (x + bw) + ' ' + y + ' ' + (x + bw) + ' ' + Math.min(y + 4, padT + plotH) + ' V' + (padT + plotH) + ' Z" class="s1" ' +
        'data-tip="<b>' + esc(labels[i]) + '</b><br>' + (opts.money ? fmtMoney(v) : fmtNum(v) + (opts.unit ? ' ' + opts.unit : '')) + '"></path>';
    }
    out += '<text x="' + (padL + i * slot + slot / 2) + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + esc(labels[i]) + '</text>';
  });
  return out + '</svg>';
}

/* Grouped columns, two series (legend rendered by chartCard) */
function groupedColumnsSVG(labels, seriesA, seriesB, opts) {
  opts = opts || {};
  var W = opts.W || 640, H = 230, padL = 52, padB = 26, padT = 12, padR = 8;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var max = Math.max.apply(null, seriesA.concat(seriesB, [1]));
  var ticks = niceTicks(max, 4);
  max = ticks[ticks.length - 1];
  var n = labels.length, slot = plotW / n;
  var bw = Math.min(14, slot * 0.28);
  var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz" role="img" aria-label="' + esc(opts.aria || 'Grouped bar chart') + '">';
  ticks.forEach(function (t) {
    var y = padT + plotH - (t / max) * plotH;
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" class="grid"></line>';
    out += '<text x="' + (padL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end" class="ax">' + fmtMoneyC(t).replace('SAR ', '') + '</text>';
  });
  function col(v, x, cls, label, name) {
    var h = (v / max) * plotH;
    if (v > 0 && h < 3) h = 3; // clamp BEFORE y so tiny commissions stay visible
    if (!h) return '';
    var y = padT + plotH - h;
    return '<path d="M' + x + ' ' + (padT + plotH) + ' V' + Math.min(y + 4, padT + plotH) + ' Q' + x + ' ' + y + ' ' + (x + 4) + ' ' + y +
      ' H' + (x + bw - 4) + ' Q' + (x + bw) + ' ' + y + ' ' + (x + bw) + ' ' + Math.min(y + 4, padT + plotH) + ' V' + (padT + plotH) + ' Z" class="' + cls + '" ' +
      'data-tip="<b>' + esc(label) + '</b><br>' + esc(name) + ': ' + fmtMoney(v) + '"></path>';
  }
  labels.forEach(function (lb, i) {
    var cx = padL + i * slot + slot / 2;
    out += col(seriesA[i], cx - bw - 1, 's1', lb, opts.nameA || 'A');
    out += col(seriesB[i], cx + 1, 's2', lb, opts.nameB || 'B');
    out += '<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + esc(lb) + '</text>';
  });
  return out + '</svg>';
}

/* Line with area wash, end dot + end label, hover bands.
   Values may contain null (= no data that period): the line breaks
   into segments and the tooltip says so, instead of faking a 0. */
function lineSVG(labels, values, opts) {
  opts = opts || {};
  var W = 640, H = 220, padL = 46, padB = 26, padT = 14, padR = 46;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var present = values.filter(function (v) { return v !== null && v !== undefined; });
  var max = Math.max.apply(null, present.concat([opts.maxHint || 1]));
  var ticks = niceTicks(max, 3);
  max = ticks[ticks.length - 1];
  var n = labels.length;
  function px(i) { return padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); }
  function py(v) { return padT + plotH - (v / max) * plotH; }
  var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz" role="img" aria-label="' + esc(opts.aria || 'Line chart') + '">';
  ticks.forEach(function (t) {
    var y = py(t);
    out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" class="grid"></line>';
    out += '<text x="' + (padL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end" class="ax">' + (opts.pct ? Math.round(t * 100) + '%' : fmtNum(t)) + '</text>';
  });
  // split into contiguous segments around nulls
  var segs = [], cur = [];
  values.forEach(function (v, i) {
    if (v === null || v === undefined) { if (cur.length) { segs.push(cur); cur = []; } }
    else cur.push(i);
  });
  if (cur.length) segs.push(cur);
  segs.forEach(function (seg) {
    var pts = seg.map(function (i) { return px(i) + ',' + py(values[i]); });
    if (seg.length > 1) {
      out += '<path d="M' + pts.join(' L') + ' L' + px(seg[seg.length - 1]) + ',' + (padT + plotH) + ' L' + px(seg[0]) + ',' + (padT + plotH) + ' Z" class="s1-wash"></path>';
      out += '<path d="M' + pts.join(' L') + '" class="s1-line"></path>';
    } else {
      out += '<circle cx="' + px(seg[0]) + '" cy="' + py(values[seg[0]]) + '" r="3.5" class="s1-dot"></circle>';
    }
  });
  labels.forEach(function (lb, i) {
    if (n <= 12 || i % 2 === 0) {
      out += '<text x="' + px(i) + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + esc(lb) + '</text>';
    }
    var isNull = values[i] === null || values[i] === undefined;
    var bandW = plotW / Math.max(n - 1, 1);
    out += '<g class="hoverpt"><rect x="' + (px(i) - bandW / 2) + '" y="' + padT + '" width="' + bandW + '" height="' + plotH + '" fill="transparent" ' +
      'data-tip="<b>' + esc(lb) + '</b><br>' + (isNull ? esc(opts.nullLabel || t('noData')) : (opts.pct ? fmtPct(values[i]) : fmtNum(values[i])) + (opts.unit ? ' ' + opts.unit : '')) + '"></rect>' +
      (isNull ? '' : '<circle cx="' + px(i) + '" cy="' + py(values[i]) + '" r="4.5" class="s1-dot ringed"></circle>') + '</g>';
  });
  // persistent dot + label on the last real value
  var lastIdx = -1;
  for (var i = n - 1; i >= 0; i--) { if (values[i] !== null && values[i] !== undefined) { lastIdx = i; break; } }
  if (lastIdx >= 0) {
    out += '<circle cx="' + px(lastIdx) + '" cy="' + py(values[lastIdx]) + '" r="4.5" class="s1-dot ringed always"></circle>';
    out += '<text x="' + (px(lastIdx) + 9) + '" y="' + (py(values[lastIdx]) + 4) + '" class="val">' + (opts.pct ? fmtPct(values[lastIdx], 0) : fmtNum(values[lastIdx])) + '</text>';
  }
  return out + '</svg>';
}

/* Horizontal bar list for reasons (label · bar · count) */
function hbarsSVG(items, opts) { // items: [{label, count}]
  opts = opts || {};
  var total = items.reduce(function (a, b) { return a + b.count; }, 0);
  if (!items.length) {
    return '<div class="empty">' + t('emptyReasons') + '</div>';
  }
  var W = 640, rowH = 30, gap = 10, labelW = 220, valueW = 96;
  var H = items.length * (rowH + gap) - gap + 4;
  var max = Math.max.apply(null, items.map(function (i) { return i.count; }).concat([1]));
  var plotW = W - labelW - valueW;
  var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz" role="img" aria-label="' + esc(opts.aria || 'Reasons') + '">';
  items.forEach(function (it, i) {
    var y = i * (rowH + gap);
    var w = Math.max(3, (it.count / max) * plotW);
    out += '<text x="' + (labelW - 10) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end" class="ax strong">' + esc(it.label) + '</text>';
    out += '<path d="' + hbarPath(labelW, y + 5, w, rowH - 10, false, true) + '" class="' + (opts.cls || 's1') + '" ' +
      'data-tip="<b>' + esc(it.label) + '</b><br>' + t('leadsPct', { n: fmtNum(it.count), pct: fmtPct(total ? it.count / total : 0, 0) }) + '"></path>';
    out += '<text x="' + (labelW + w + 8) + '" y="' + (y + rowH / 2 + 4) + '" class="val">' + fmtNum(it.count) +
      ' <tspan class="dim-t">· ' + fmtPct(total ? it.count / total : 0, 0) + '</tspan></text>';
  });
  return out + '</svg>';
}

/* Single horizontal stacked bar for outcome split (part-to-whole) */
function stackedBarSVG(segments, opts) { // [{label, count, cls}]
  opts = opts || {};
  var total = segments.reduce(function (a, s) { return a + s.count; }, 0) || 1;
  var W = 640, H = 64, barH = 22, y = 8;
  var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz" role="img" aria-label="' + esc(opts.aria || 'Outcome split') + '">';
  var nonZero = segments.filter(function (s) { return s.count > 0; });
  var x = 0;
  nonZero.forEach(function (s, i) {
    var w = (s.count / total) * W;
    var valTxt = opts.money ? fmtMoney(s.count) : fmtNum(s.count) + ' ' + t('leadsUnit');
    // 2px surface gap between segments; only the outer ends are rounded
    out += '<path d="' + hbarPath(x + 1, y, Math.max(w - 2, 2), barH, i === 0, i === nonZero.length - 1) + '" class="' + s.cls + '" ' +
      'data-tip="<b>' + esc(s.label) + '</b><br>' + valTxt + ' (' + fmtPct(s.count / total, 0) + ')"></path>';
    if (w > 56) {
      out += '<text x="' + (x + w / 2) + '" y="' + (y + barH + 22) + '" text-anchor="middle" class="ax">' + fmtPct(s.count / total, 0) + '</text>';
    }
    x += w;
  });
  return out + '</svg>';
}

/* Tiny sparkline for stat tiles / leaderboard */
function sparkSVG(values, w, h) {
  w = w || 96; h = h || 28;
  var max = Math.max.apply(null, values.concat([1]));
  var n = values.length;
  function px(i) { return 2 + (i / Math.max(n - 1, 1)) * (w - 4); }
  function py(v) { return h - 3 - (v / max) * (h - 8); }
  var pts = values.map(function (v, i) { return px(i) + ',' + py(v); });
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="spark" aria-hidden="true">' +
    '<path d="M' + pts.join(' L') + '" class="spark-line"></path>' +
    '<circle cx="' + px(n - 1) + '" cy="' + py(values[n - 1]) + '" r="3" class="s1-dot"></circle></svg>';
}
