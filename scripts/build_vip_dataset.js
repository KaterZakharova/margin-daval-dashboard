// Build VIP top-20 dataset for margin-vip-clients page.
// Reads data.json → outputs vip-clients/src/data/clients.json
//
// Rules:
//   - normalize customer names: trim, drop trailing " (S3)" suffix → merge duplicates
//   - explicit alias merge: ЛАКСА ТРЕЙДИНГ АО → ЮВЕЛИТ АО (per user)
//   - excluded clients: Кирюхин ИП, КОСМОКОД
//   - top-20 = 19 from dashboard screenshot + ВКУСВИЛЛ
//   - per client: full monthly time series (revenue, qty, marginRub) from first → last appearance
//   - aggregate: month-by-month sum across all 20

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data.json');
const OUT_DIR = path.join(__dirname, '..', 'vip-clients', 'src', 'data');
const OUT = path.join(OUT_DIR, 'clients.json');

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const sales = data.sales;

// ---- normalization -----------------------------------------------------------
function normalize(raw) {
  let n = raw.trim();
  n = n.replace(/\s*\(S3\)\s*$/i, '');     // strip channel marker
  n = n.replace(/\s+/g, ' ');               // collapse internal spaces
  return n.trim();
}

const ALIASES = {
  'ЛАКСА ТРЕЙДИНГ АО': 'ЮВЕЛИТ АО',  // user: same legal entity
};
function canonical(raw) {
  const n = normalize(raw);
  return ALIASES[n] || n;
}

// ---- vip universe ------------------------------------------------------------
const VIP_LIST = [
  { slug: 'gorelov',     name: 'Горелов Никита Александрович ИП', displayName: 'Горелов Н.А. ИП',     rank: 1 },
  { slug: 'matrix',      name: 'МАТРИКС ООО',                      displayName: 'МАТРИКС',             rank: 2 },
  { slug: 'integral',    name: 'ИНТЕГРАААЛ ООО',                    displayName: 'ИНТЕГРАААЛ',          rank: 3 },
  { slug: 'uvelit',      name: 'ЮВЕЛИТ АО',                         displayName: 'ЮВЕЛИТ (бывш. ЛАКСА)', rank: 4 },
  { slug: 'kearly',      name: 'КЕАРЛИ ГРУПП ООО',                  displayName: 'КЕАРЛИ ГРУПП',        rank: 5 },
  { slug: 'mona-biolab', name: 'МОНА БИОЛАБ ООО',                   displayName: 'МОНА БИОЛАБ',         rank: 6 },
  { slug: 'babykin',     name: 'Бабыкин Алексей Викторович ИП',     displayName: 'Бабыкин А.В. ИП',     rank: 7 },
  { slug: 'healscare',   name: 'ХЭЛСКЕА СОЛЮШНС ООО',               displayName: 'ХЭЛСКЕА СОЛЮШНС',     rank: 8 },
  { slug: 'alekseyuk',   name: 'Алексеюк Алла Анатольевна ИП',      displayName: 'Алексеюк А.А. ИП',    rank: 9 },
  { slug: 'myslinsky',   name: 'Мыслинский Иван Владимирович ИП',   displayName: 'Мыслинский И.В. ИП',  rank: 10 },
  { slug: 'cosmo-beauty',name: 'КОСМО БЬЮТИ ООО',                   displayName: 'КОСМО БЬЮТИ',         rank: 11 },
  { slug: 'openface',    name: 'ОПЕНФЕЙС ООО',                      displayName: 'ОПЕНФЕЙС',            rank: 12 },
  { slug: 'smart-sale',  name: 'СМАРТ-СЭЙЛ ООО',                    displayName: 'СМАРТ-СЭЙЛ',          rank: 13 },
  { slug: 'bestland',    name: 'ООО БЕСТЛАНД',                      displayName: 'БЕСТЛАНД',            rank: 14 },
  { slug: 'sviridova',   name: 'Свиридова Ольга Константиновна ИП', displayName: 'Свиридова О.К. ИП',   rank: 15 },
  { slug: 'ingeokom',    name: 'ИНГЕОКОМ ДИСТРИБЬЮШЕН ПАРТНЕРС АО', displayName: 'ИНГЕОКОМ',            rank: 16 },
  { slug: 'iqkea',       name: 'АЙКЬЮКЕА ООО',                      displayName: 'АЙКЬЮКЕА',            rank: 17 },
  { slug: 'beauty-service', name: 'БЬЮТИ СЕРВИС ООО',                displayName: 'БЬЮТИ СЕРВИС',        rank: 18 },
  { slug: 'krygina',     name: 'КРЫГИНА КОСМЕТИКС ООО',             displayName: 'КРЫГИНА КОСМЕТИКС',   rank: 19 },
  { slug: 'vkusvill',    name: 'ВКУСВИЛЛ АО',                       displayName: 'ВКУСВИЛЛ',            rank: 20 },
  { slug: 'semi',        name: 'СЭМИ КОСМЕТИК ООО',                 displayName: 'СЭМИ КОСМЕТИК (Semily)', rank: 21 },
  { slug: 'nuolab',      name: 'НУОЛАБ ООО (бывш. ПУРПУР ООО)',     displayName: 'НУОЛАБ (бывш. ПУРПУР)', rank: 22 },
];
const VIP_BY_CANON = new Map(VIP_LIST.map(v => [v.name, v]));

// ---- bucket sales rows by canonical name ------------------------------------
const buckets = new Map();   // canonical → { rawNames:Set, rows:[] }
for (const r of sales) {
  const c = canonical(r.customer);
  if (!VIP_BY_CANON.has(c)) continue;
  if (!buckets.has(c)) buckets.set(c, { rawNames: new Set(), rows: [] });
  const b = buckets.get(c);
  b.rawNames.add(r.customer);
  b.rows.push(r);
}

// ---- determine month axis (earliest first-month across vips → latest month) -
function ymKey(year, monthNum) { return `${year}-${String(monthNum).padStart(2,'0')}`; }
function ymToIdx(ym) { const [y,m]=ym.split('-').map(Number); return y*12 + m - 1; }
function idxToYm(i)  { const y=Math.floor(i/12); const m=(i%12)+1; return `${y}-${String(m).padStart(2,'0')}`; }

const allMonths = new Set();
for (const r of sales) allMonths.add(ymKey(r.year, r.monthNum));
const monthsAxisGlobal = [...allMonths].sort();   // global min..max

const cutoff = data.meta.endDateExclusive; // 2026-06-10 → last full month = 2026-05
const cutoffYm = cutoff.slice(0,7);
const lastFullMonth = (() => {
  // if cutoff is the 1st → previous month; else current month is partial → previous
  // To be safe, we exclude any month >= cutoffYm to avoid partial months.
  return idxToYm(ymToIdx(cutoffYm) - 1);
})();

// ---- aggregate per client ---------------------------------------------------
const clients = [];
const aggMonthly = new Map();  // ym → {revenue, qty, marginRub}

for (const vip of VIP_LIST) {
  const b = buckets.get(vip.name);
  if (!b) {
    console.warn(`[WARN] нет данных для ${vip.name}`);
    continue;
  }

  // monthly aggregate
  const monthly = new Map();   // ym → {revenue, qty, marginRub}
  const managerCounts = new Map();
  const skuStats = new Map();   // sku → {name, revenue2025}
  const schemes = new Map();
  let revenue2024 = 0, revenue2025 = 0;
  let ytd2025 = 0, ytd2026 = 0;  // jan..may both years
  let qty2024 = 0, qty2025 = 0;
  let margin2024 = 0, margin2025 = 0;

  // Cap monthly to last full month (drop partial June 2026)
  for (const r of b.rows) {
    if (r.monthNum > 5 && r.year === 2026) continue;  // skip June'26 partial+
    const ym = ymKey(r.year, r.monthNum);
    if (ym > lastFullMonth) continue;
    if (!monthly.has(ym)) monthly.set(ym, { revenue: 0, qty: 0, marginRub: 0 });
    const m = monthly.get(ym);
    m.revenue   += r.revenue;
    m.qty       += r.qty;
    m.marginRub += r.marginRub;

    // aggregate axis
    if (!aggMonthly.has(ym)) aggMonthly.set(ym, { revenue: 0, qty: 0, marginRub: 0 });
    const a = aggMonthly.get(ym);
    a.revenue   += r.revenue;
    a.qty       += r.qty;
    a.marginRub += r.marginRub;

    if (r.year === 2024) { revenue2024 += r.revenue; qty2024 += r.qty; margin2024 += r.marginRub; }
    if (r.year === 2025) {
      revenue2025 += r.revenue; qty2025 += r.qty; margin2025 += r.marginRub;
      if (r.monthNum <= 5) ytd2025 += r.revenue;
      // top SKU by 2025 revenue
      const s = skuStats.get(r.sku) || { sku: r.sku, name: r.productName, revenue2025: 0 };
      s.revenue2025 += r.revenue;
      skuStats.set(r.sku, s);
    }
    if (r.year === 2026 && r.monthNum <= 5) ytd2026 += r.revenue;

    if (r.manager) managerCounts.set(r.manager, (managerCounts.get(r.manager) || 0) + r.revenue);
    schemes.set(r.scheme, (schemes.get(r.scheme) || 0) + r.revenue);
  }

  const monthsSorted = [...monthly.keys()].sort();
  const firstMonth = monthsSorted[0] || null;
  const lastMonth  = monthsSorted[monthsSorted.length - 1] || null;

  // fill missing months with zeros between firstMonth and lastFullMonth
  const series = [];
  if (firstMonth) {
    for (let i = ymToIdx(firstMonth); i <= ymToIdx(lastFullMonth); i++) {
      const ym = idxToYm(i);
      const m = monthly.get(ym) || { revenue: 0, qty: 0, marginRub: 0 };
      series.push({ month: ym, revenue: m.revenue, qty: m.qty, marginRub: m.marginRub });
    }
  }

  // forecast 2026:
  //   primary  = seasonal:  YTD'26 × (full_2025 / YTD'25), cap factor at 2.5
  //   fallback = naive:     YTD'26 × 2   (когда YTD'25=0 но клиент работал и есть полный 2025)
  //   none     = ничего, если нет ни 2025-базы, ни YTD'26
  const FACTOR_CAP = 2.5;
  let forecast2026 = null;
  let forecastSource = 'none';  // 'seasonal' | 'naive' | 'none'
  let forecastCapped = false;

  if (ytd2025 > 0) {
    let f = revenue2025 / ytd2025;
    if (f > FACTOR_CAP) { f = FACTOR_CAP; forecastCapped = true; }
    forecast2026 = ytd2026 * f;
    forecastSource = 'seasonal';
  } else if (revenue2025 > 0 && ytd2026 > 0) {
    forecast2026 = ytd2026 * 2;
    forecastSource = 'naive';
  } else if (revenue2025 > 0 && ytd2026 === 0) {
    forecast2026 = 0;            // не отгружают в 2026 H1 — прогноз 0
    forecastSource = 'naive';
  }

  const deltaAbs = forecast2026 !== null ? forecast2026 - revenue2025 : null;
  const deltaPct = (forecast2026 !== null && revenue2025 > 0) ? deltaAbs / revenue2025 * 100 : null;
  const ytdDeltaPct = ytd2025 > 0 ? (ytd2026 - ytd2025) / ytd2025 * 100 : null;

  // peak: максимальный из 2024/2025; recoveryPct = forecast2026 / peak.
  // Нужно чтобы клиент с большим обвалом 2024→2025 НЕ помечался «растёт» только потому
  // что прогноз 2026 чуть выше провального 2025.
  const peakRevenue = Math.max(revenue2024, revenue2025);
  const peakYear = revenue2024 >= revenue2025 ? 2024 : 2025;
  const recoveryPct = peakRevenue > 0 && forecast2026 !== null
    ? forecast2026 / peakRevenue * 100
    : null;
  const deltaVsPeak = forecast2026 !== null ? forecast2026 - peakRevenue : null;

  // status: новичок > ушёл/пауза > сравнение vs пика (если peak=2024 и не восстановились) > обычный YoY
  const monthsSortedForStatus = [...monthly.keys()].sort();
  const firstMonthLocal = monthsSortedForStatus[0] || null;
  const isNewIn2025 = firstMonthLocal !== null && firstMonthLocal >= '2025-01';
  const collapsedSincePeak = peakYear === 2024 && recoveryPct !== null && recoveryPct < 50;

  let status, statusLabel;
  if (isNewIn2025)                              { status = 'new';  statusLabel = 'новичок 2025'; }
  else if (revenue2025 === 0 && revenue2024 > 0 && ytd2026 === 0) { status = 'gone';   statusLabel = 'ушёл'; }
  else if (revenue2025 > 0 && ytd2026 === 0)    { status = 'paused'; statusLabel = 'пауза в 2026'; }
  else if (collapsedSincePeak && recoveryPct < 30) { status = 'crash'; statusLabel = `обвал (${recoveryPct.toFixed(0)}% от 2024)`; }
  else if (collapsedSincePeak)                  { status = 'down';   statusLabel = `не восст. (${recoveryPct.toFixed(0)}% от 2024)`; }
  else if (deltaPct !== null && deltaPct < -50) { status = 'crash';  statusLabel = 'обвал'; }
  else if (deltaPct !== null && deltaPct < -15) { status = 'down';   statusLabel = 'падает'; }
  else if (deltaPct !== null && deltaPct > 15)  { status = 'up';     statusLabel = 'растёт'; }
  else                                          { status = 'stable'; statusLabel = 'стабильно'; }

  const managers = [...managerCounts.entries()].sort((a,b) => b[1]-a[1]).map(([n]) => n);
  const topSkus  = [...skuStats.values()].sort((a,b) => b.revenue2025 - a.revenue2025).slice(0, 3);
  const topScheme= [...schemes.entries()].sort((a,b) => b[1]-a[1])[0]?.[0] || '';

  clients.push({
    slug: vip.slug,
    name: vip.name,
    displayName: vip.displayName,
    rank: vip.rank,
    managers,
    topScheme,
    firstMonth, lastMonth,
    monthly: series,
    stats: {
      revenue2024Full: Math.round(revenue2024),
      revenue2025Full: Math.round(revenue2025),
      revenueYtd2025:  Math.round(ytd2025),
      revenueYtd2026:  Math.round(ytd2026),
      qty2024Full: Math.round(qty2024),
      qty2025Full: Math.round(qty2025),
      margin2024Full: Math.round(margin2024),
      margin2025Full: Math.round(margin2025),
      forecast2026: forecast2026 !== null ? Math.round(forecast2026) : null,
      forecastSource,
      forecastCapped,
      deltaAbs: deltaAbs !== null ? Math.round(deltaAbs) : null,
      deltaPct: deltaPct !== null ? Math.round(deltaPct * 10) / 10 : null,
      ytdDeltaPct: ytdDeltaPct !== null ? Math.round(ytdDeltaPct * 10) / 10 : null,
      peakRevenue: Math.round(peakRevenue),
      peakYear,
      recoveryPct: recoveryPct !== null ? Math.round(recoveryPct * 10) / 10 : null,
      deltaVsPeak: deltaVsPeak !== null ? Math.round(deltaVsPeak) : null,
    },
    status,
    statusLabel,
    topSkus,
    mergedFrom: [...b.rawNames],
  });
}
clients.sort((a, b) => a.rank - b.rank);

// ---- aggregate axis VIP: full range from earliest VIP first month → lastFullMonth
const aggFirstMonth = clients.reduce((min, c) => c.firstMonth && (!min || c.firstMonth < min) ? c.firstMonth : min, null);
const aggMonths = [];
if (aggFirstMonth) {
  for (let i = ymToIdx(aggFirstMonth); i <= ymToIdx(lastFullMonth); i++) {
    const ym = idxToYm(i);
    const m = aggMonthly.get(ym) || { revenue: 0, qty: 0, marginRub: 0 };
    aggMonths.push({ month: ym, revenue: Math.round(m.revenue), qty: Math.round(m.qty), marginRub: Math.round(m.marginRub) });
  }
}

// ---- aggregate ALL S3 clients (помесячно по всему канналу) -------------------
const aggAllMonthly = new Map();
const allUniqueCustomers = new Set();
for (const r of sales) {
  allUniqueCustomers.add(canonical(r.customer));
  if (r.year === 2026 && r.monthNum > 5) continue;   // skip partial June
  const ym = ymKey(r.year, r.monthNum);
  if (ym > lastFullMonth) continue;
  if (!aggAllMonthly.has(ym)) aggAllMonthly.set(ym, { revenue: 0, qty: 0, marginRub: 0 });
  const m = aggAllMonthly.get(ym);
  m.revenue   += r.revenue;
  m.qty       += r.qty;
  m.marginRub += r.marginRub;
}
const aggAllSortedMonths = [...aggAllMonthly.keys()].sort();
const aggAllFirstMonth = aggAllSortedMonths[0];
const aggregateAll = [];
if (aggAllFirstMonth) {
  for (let i = ymToIdx(aggAllFirstMonth); i <= ymToIdx(lastFullMonth); i++) {
    const ym = idxToYm(i);
    const m = aggAllMonthly.get(ym) || { revenue: 0, qty: 0, marginRub: 0 };
    aggregateAll.push({ month: ym, revenue: Math.round(m.revenue), qty: Math.round(m.qty), marginRub: Math.round(m.marginRub) });
  }
}

const out = {
  meta: {
    generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    sourceFile: 'data.json',
    sourceGeneratedAt: data.meta.generatedAt,
    endDateExclusive: data.meta.endDateExclusive,
    lastFullMonth,
    totalClients: clients.length,
    totalAllClientsS3: allUniqueCustomers.size,
  },
  aggregate: aggMonths,
  aggregateAll,
  clients,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(`Wrote ${OUT}`);
console.log(`Clients: ${clients.length}, months in aggregate: ${aggMonths.length}, lastFullMonth: ${lastFullMonth}`);
for (const c of clients) {
  const s = c.stats;
  console.log(`  ${String(c.rank).padStart(2)}. ${c.displayName.padEnd(28)} ${c.statusLabel.padEnd(14)} 2025=${(s.revenue2025Full/1e6).toFixed(1).padStart(5)}M  forecast26=${s.forecast2026 !== null ? (s.forecast2026/1e6).toFixed(1).padStart(5) : '   —'}M  Δ=${s.deltaPct !== null ? (s.deltaPct>0?'+':'')+s.deltaPct+'%' : '—'} [merged ${c.mergedFrom.length}]`);
}
