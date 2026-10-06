// Søylediagram (SVG) fra en oppgavetabell: første kolonne er kategorier, resten er dataserier.
// Brukes både i oppgavene og på utskriftssiden.
(() => {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (cell) => {
    const n = Number(String(cell).replace(/[^\d,.\-−]/g, "").replace("−", "-").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };
  const fmt = (n) => String(n).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const COLORS = ["#d9661f", "#3f6fb5", "#2e8b57", "#8c5bb5"];

  function niceStep(max) {
    for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000]) {
      if (max / step <= 6) return step;
    }
    return Math.ceil(max / 6);
  }

  window.barChartSvg = function barChartSvg(table) {
    const series = table.headers.slice(1);
    const rows = table.rows.map((r) => ({ label: r[0], values: series.map((_, k) => num(r[k + 1])) }));
    const max = Math.max(1, ...rows.flatMap((r) => r.values));
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;

    const W = 560, H = 280, left = 52, right = 12, topPad = 26, bottom = 46;
    const plotW = W - left - right, plotH = H - topPad - bottom;
    const groupW = plotW / rows.length;
    const barW = Math.min(46, (groupW * 0.7) / series.length);
    const y = (v) => topPad + plotH - (v / top) * plotH;

    let grid = "";
    for (let v = 0; v <= top; v += step) {
      grid += `<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="#d9d2c7" stroke-width="1"/>`;
      grid += `<text x="${left - 6}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="#5f5850">${fmt(v)}</text>`;
    }
    let bars = "";
    rows.forEach((r, i) => {
      const x0 = left + i * groupW + (groupW - barW * series.length) / 2;
      r.values.forEach((v, k) => {
        const x = x0 + k * barW;
        bars += `<rect x="${x + 1}" y="${y(v)}" width="${barW - 2}" height="${Math.max(0, y(0) - y(v))}" fill="${COLORS[k % COLORS.length]}" rx="2"/>`;
      });
      bars += `<text x="${left + i * groupW + groupW / 2}" y="${H - bottom + 18}" text-anchor="middle" font-size="12" fill="#1d1b18">${esc(r.label)}</text>`;
    });
    const legend = series.length > 1
      ? series.map((s, k) => `<rect x="${left + k * 130}" y="${H - 14}" width="12" height="12" fill="${COLORS[k % COLORS.length]}" rx="2"/><text x="${left + k * 130 + 17}" y="${H - 4}" font-size="12" fill="#1d1b18">${esc(s)}</text>`).join("")
      : "";
    const axisTitle = series.length === 1 ? `<text x="${left}" y="14" font-size="12" fill="#5f5850">${esc(series[0])}</text>` : "";

    return `<svg class="bar-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Søylediagram: ${esc(table.headers.join(", "))}">
      ${axisTitle}${grid}
      <line x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}" stroke="#1d1b18" stroke-width="1.5"/>
      ${bars}${legend}
    </svg>`;
  };
})();
