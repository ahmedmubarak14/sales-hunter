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

function fmtMoney(n) { return 'SAR ' + Math.round(n).toLocaleString('en-US'); }
function fmtMoneyC(n) { // compact
  if (Math.abs(n) >= 1e6) return 'SAR ' + (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (Math.abs(n) >= 1e3) return 'SAR ' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return 'SAR ' + Math.round(n);
}
function fmtPct(x, dp) { return (x * 100).toFixed(dp === undefined ? 1 : dp) + '%'; }
function fmtDate(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
function fmtNum(n) { return Math.round(n).toLocaleString('en-US'); }

/* Clean axis ticks: 0..max rounded to a friendly step */
function niceTicks(maxVal, count) {
  if (maxVal <= 0) maxVal = 1;
  var rough = maxVal / count;
  var mag = Math.pow(10, Math.floor(Math.log10(rough)));
  var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; })
    .find(function (s) { return s >= rough; }) || 10 * mag;
  var ticks = [];
  for (var v = 0; v <= maxVal + step * 0.999; v += step) ticks.push(v);
  return ticks;
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
      (opts.table ? '<button class="ghost-btn" data-toggle-table="' + id + '" aria-pressed="false">Data</button>' : '') +
    '</div>' +
    legend +
    '<div class="chart-view">' + opts.svg + '</div>' +
    '<div class="table-view" hidden>' + table + '</div>' +
  '</section>';
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
      btn.textContent = showTable ? 'Chart' : 'Data';
    });
  });
}

/* ============================================================
   Chart renderers — each returns an SVG string
   ============================================================ */

/* Funnel: horizontal bars on the ordinal ramp, count at bar end,
   stage-to-stage conversion between rows. */
function funnelSVG(rows) { // rows: [{stage, count}]
  var W = 640, rowH = 44, gap = 14, labelW = 172, valueW = 88;
  var H = rows.length * (rowH + gap) - gap + 8;
  var max = Math.max.apply(null, rows.map(function (r) { return r.count; }).concat([1]));
  var plotW = W - labelW - valueW;
  var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz" role="img" aria-label="Pipeline funnel">';
  rows.forEach(function (r, i) {
    var y = i * (rowH + gap) + 4;
    var w = Math.max(4, (r.count / max) * plotW);
    var pct = i === 0 ? null : (rows[i - 1].count ? r.count / rows[i - 1].count : 0);
    out += '<text x="' + (labelW - 10) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end" class="ax strong">' + esc(r.stage) + '</text>';
    out += '<rect x="' + labelW + '" y="' + y + '" width="' + w + '" height="' + (rowH - 16) + '" rx="4" class="f' + (i + 1) + '" ' +
      'data-tip="<b>' + esc(r.stage) + '</b><br>' + fmtNum(r.count) + ' leads reached' +
      (pct !== null ? '<br>' + fmtPct(pct, 0) + ' of previous stage' : '') + '"></rect>';
    out += '<text x="' + (labelW + w + 8) + '" y="' + (y + (rowH - 16) / 2 + 4) + '" class="val">' + fmtNum(r.count) + '</text>';
    if (pct !== null) {
      out += '<text x="' + (labelW - 10) + '" y="' + (y + rowH / 2 + 18) + '" text-anchor="end" class="ax dim">' + fmtPct(pct, 0) + ' →</text>';
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
  var ticks = niceTicks(max, 4);
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
    var x = padL + i * slot + (slot - bw) / 2;
    var y = padT + plotH - h;
    out += '<path d="M' + x + ' ' + (padT + plotH) + ' V' + (y + 4) + ' Q' + x + ' ' + y + ' ' + (x + 4) + ' ' + y +
      ' H' + (x + bw - 4) + ' Q' + (x + bw) + ' ' + y + ' ' + (x + bw) + ' ' + (y + 4) + ' V' + (padT + plotH) + ' Z" class="s1" ' +
      'data-tip="<b>' + esc(labels[i]) + '</b><br>' + (opts.money ? fmtMoney(v) : fmtNum(v) + (opts.unit ? ' ' + opts.unit : '')) + '"></path>';
    out += '<text x="' + (padL + i * slot + slot / 2) + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + esc(labels[i]) + '</text>';
  });
  return out + '</svg>';
}

/* Grouped columns, two series (legend rendered by chartCard) */
function groupedColumnsSVG(labels, seriesA, seriesB, opts) {
  opts = opts || {};
  var W = 640, H = 230, padL = 52, padB = 26, padT = 12, padR = 8;
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
    var h = (v / max) * plotH, y = padT + plotH - h;
    if (h < 4) h = Math.max(h, v > 0 ? 3 : 0);
    if (!h) return '';
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

/* Line with area wash, end dot + end label, hover bands */
function lineSVG(labels, values, opts) {
  opts = opts || {};
  var W = 640, H = 220, padL = 46, padB = 26, padT = 14, padR = 46;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var max = Math.max.apply(null, values.concat([opts.maxHint || 1]));
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
  var pts = values.map(function (v, i) { return px(i) + ',' + py(v); });
  out += '<path d="M' + pts.join(' L') + ' L' + px(n - 1) + ',' + (padT + plotH) + ' L' + px(0) + ',' + (padT + plotH) + ' Z" class="s1-wash"></path>';
  out += '<path d="M' + pts.join(' L') + '" class="s1-line"></path>';
  labels.forEach(function (lb, i) {
    if (n <= 12 || i % 2 === 0) {
      out += '<text x="' + px(i) + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + esc(lb) + '</text>';
    }
    // invisible hover band + hover dot
    var bandW = plotW / Math.max(n - 1, 1);
    out += '<g class="hoverpt"><rect x="' + (px(i) - bandW / 2) + '" y="' + padT + '" width="' + bandW + '" height="' + plotH + '" fill="transparent" ' +
      'data-tip="<b>' + esc(lb) + '</b><br>' + (opts.pct ? fmtPct(values[i]) : fmtNum(values[i])) + (opts.unit ? ' ' + opts.unit : '') + '"></rect>' +
      '<circle cx="' + px(i) + '" cy="' + py(values[i]) + '" r="4.5" class="s1-dot ringed"></circle></g>';
  });
  // persistent end dot + label
  out += '<circle cx="' + px(n - 1) + '" cy="' + py(values[n - 1]) + '" r="4.5" class="s1-dot ringed always"></circle>';
  out += '<text x="' + (px(n - 1) + 9) + '" y="' + (py(values[n - 1]) + 4) + '" class="val">' + (opts.pct ? fmtPct(values[n - 1], 0) : fmtNum(values[n - 1])) + '</text>';
  return out + '</svg>';
}

/* Horizontal bar list for reasons (label · bar · count) */
function hbarsSVG(items, opts) { // items: [{label, count}]
  opts = opts || {};
  var total = items.reduce(function (a, b) { return a + b.count; }, 0);
  if (!items.length) {
    return '<div class="empty">No data yet — nothing in this category. That is good news.</div>';
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
    out += '<rect x="' + labelW + '" y="' + (y + 5) + '" width="' + w + '" height="' + (rowH - 10) + '" rx="4" class="' + (opts.cls || 's1') + '" ' +
      'data-tip="<b>' + esc(it.label) + '</b><br>' + fmtNum(it.count) + ' leads (' + fmtPct(total ? it.count / total : 0, 0) + ')"></rect>';
    out += '<text x="' + (labelW + w + 8) + '" y="' + (y + rowH / 2 + 4) + '" class="val">' + fmtNum(it.count) +
      ' <tspan class="dim-t">· ' + fmtPct(total ? it.count / total : 0, 0) + '</tspan></text>';
  });
  return out + '</svg>';
}

/* Single horizontal stacked bar for outcome split (part-to-whole) */
function stackedBarSVG(segments) { // [{label, count, cls}]
  var total = segments.reduce(function (a, s) { return a + s.count; }, 0) || 1;
  var W = 640, H = 64, barH = 22, y = 8;
  var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz" role="img" aria-label="Outcome split">';
  var x = 0;
  segments.forEach(function (s) {
    if (!s.count) return;
    var w = (s.count / total) * W;
    // 2px surface gap between segments via stroke on surface color handled by CSS gap class
    out += '<rect x="' + (x + 1) + '" y="' + y + '" width="' + Math.max(w - 2, 2) + '" height="' + barH + '" rx="4" class="' + s.cls + '" ' +
      'data-tip="<b>' + esc(s.label) + '</b><br>' + fmtNum(s.count) + ' leads (' + fmtPct(s.count / total, 0) + ')"></rect>';
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
