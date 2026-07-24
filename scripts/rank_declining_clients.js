// Топ-20 ключевых клиентов 2025 + динамика 2024/2025/2026 + прогноз
// Окно сравнения: янв-1 → 9 июня (cut-off = endDateExclusive в data.json)
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
const sales = data.sales;
const cutoffEx = new Date(data.meta.endDateExclusive); // 2026-06-10
const cutoffMonth = cutoffEx.getUTCMonth() + 1; // 6
const cutoffDay = cutoffEx.getUTCDate();        // 10 (exclusive)

// sales rows are monthly aggregate => approximate YTD by full-month inclusion up to month=5 (May)
// June 2026 partial → exclude from YTD comparison to keep apples-to-apples
const ytdMaxMonth = cutoffMonth - 1; // 5 = janv..may

function isYtd(year, monthNum) { return monthNum >= 1 && monthNum <= ytdMaxMonth; }

const agg = {};
for (const r of sales) {
  const c = r.customer;
  if (!agg[c]) agg[c] = { years: {}, ytd: {}, managers: new Set(), schemes: {} };
  const y = r.year;
  if (!agg[c].years[y]) agg[c].years[y] = { full: 0, byMonth: {} };
  agg[c].years[y].full += r.revenue;
  agg[c].years[y].byMonth[r.monthNum] = (agg[c].years[y].byMonth[r.monthNum] || 0) + r.revenue;
  if (isYtd(y, r.monthNum)) {
    agg[c].ytd[y] = (agg[c].ytd[y] || 0) + r.revenue;
  }
  if (r.manager) agg[c].managers.add(r.manager);
  agg[c].schemes[r.scheme] = (agg[c].schemes[r.scheme] || 0) + r.revenue;
}

const top = Object.entries(agg)
  .map(([c, x]) => {
    const r2024 = x.years[2024]?.full || 0;
    const r2025 = x.years[2025]?.full || 0;
    const r2026 = x.years[2026]?.full || 0;
    const ytd2025 = x.ytd[2025] || 0;
    const ytd2026 = x.ytd[2026] || 0;
    const seasFactor = ytd2025 > 0 ? r2025 / ytd2025 : null;
    const forecast2026 = seasFactor ? ytd2026 * seasFactor : null;
    const deltaAbs = forecast2026 !== null ? forecast2026 - r2025 : null;
    const deltaPct = (forecast2026 !== null && r2025 > 0) ? deltaAbs / r2025 * 100 : null;
    const ytdDeltaPct = ytd2025 > 0 ? (ytd2026 - ytd2025) / ytd2025 * 100 : null;
    const topScheme = Object.entries(x.schemes).sort((a,b) => b[1]-a[1])[0]?.[0] || '';
    return {
      customer: c,
      managers: [...x.managers].join(' / '),
      scheme: topScheme,
      r2024, r2025, r2026_ytd: ytd2026, ytd2025, forecast2026,
      deltaAbs, deltaPct, ytdDeltaPct,
      lastMonth: Math.max(...Object.keys(x.years[2026]?.byMonth || {0:0}).map(Number)) || 0,
    };
  })
  .sort((a, b) => b.r2025 - a.r2025)
  .slice(0, 20);

const fmt = (n) => n === null ? '—' : (Math.round(n / 1000)).toLocaleString('ru-RU') + ' тыс';
const pct = (n) => n === null ? '—' : (n > 0 ? '+' : '') + n.toFixed(0) + '%';

console.log(`Окно YTD: янв-май обоих годов (июнь 2026 неполный, исключён)`);
console.log(`Топ-20 клиентов по выручке 2025 (полный год):\n`);
console.log('# | Клиент'.padEnd(48) + ' | 2024'.padEnd(14) + ' | 2025'.padEnd(14) + ' | YTD25'.padEnd(13) + ' | YTD26'.padEnd(13) + ' | Δ YTD%'.padEnd(9) + ' | Прогноз26'.padEnd(13) + ' | Δ vs 2025'.padEnd(13) + ' | Δ%'.padEnd(8) + ' | посл.мес');
console.log('-'.repeat(170));
top.forEach((t, i) => {
  const flag = t.deltaPct === null ? '' : t.deltaPct < -30 ? ' 🔴' : t.deltaPct < -10 ? ' 🟡' : t.deltaPct > 5 ? ' 🟢' : '';
  console.log(
    `${String(i+1).padStart(2)} | ${t.customer.slice(0, 42).padEnd(42)}`+
    ` | ${fmt(t.r2024).padStart(11)}` +
    ` | ${fmt(t.r2025).padStart(11)}` +
    ` | ${fmt(t.ytd2025).padStart(10)}` +
    ` | ${fmt(t.r2026_ytd).padStart(10)}` +
    ` | ${pct(t.ytdDeltaPct).padStart(6)}` +
    ` | ${fmt(t.forecast2026).padStart(10)}` +
    ` | ${fmt(t.deltaAbs).padStart(10)}` +
    ` | ${pct(t.deltaPct).padStart(5)}` +
    ` | ${String(t.lastMonth).padStart(2)}${flag}`
  );
});

const totalLoss = top.filter(t => t.deltaAbs !== null && t.deltaAbs < 0).reduce((s, t) => s + t.deltaAbs, 0);
const totalGain = top.filter(t => t.deltaAbs !== null && t.deltaAbs > 0).reduce((s, t) => s + t.deltaAbs, 0);
console.log(`\nИтого по топ-20 (прогноз vs 2025): потери ${fmt(totalLoss)}, прибыль ${fmt(totalGain)}, нетто ${fmt(totalLoss + totalGain)}`);

const total2025 = top.reduce((s, t) => s + t.r2025, 0);
const totalForecast = top.reduce((s, t) => s + (t.forecast2026 || 0), 0);
console.log(`Совокупный объём топ-20: 2025 = ${fmt(total2025)}, прогноз 2026 = ${fmt(totalForecast)} (${((totalForecast - total2025) / total2025 * 100).toFixed(1)}%)`);
