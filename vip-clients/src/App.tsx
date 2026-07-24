import { useState, useMemo, useRef } from 'react';
import dataset from './data/clients.json';
import type { Dataset, ClientRecord, Metric } from './types';
import YearlyComparisonChart from './components/YearlyComparisonChart';
import ClientCard from './components/ClientCard';
import ClientModal from './components/ClientModal';
import { fmtRub, fmtMonth, fmtPct } from './format';

const ds = dataset as unknown as Dataset;

type HighlightGroup = 'losing' | 'gaining' | null;

export default function App() {
  const [metric, setMetric] = useState<Metric>('revenue');
  const [openClient, setOpenClient] = useState<ClientRecord | null>(null);
  const [highlight, setHighlight] = useState<HighlightGroup>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const losingSet  = useMemo(() => new Set(ds.clients.filter(c => ['crash','down','gone','paused'].includes(c.status)).map(c => c.slug)), []);
  const gainingSet = useMemo(() => new Set(ds.clients.filter(c => c.status === 'up').map(c => c.slug)), []);
  const highlightSet = highlight === 'losing' ? losingSet : highlight === 'gaining' ? gainingSet : null;

  const handleKPIClick = (group: HighlightGroup) => {
    setHighlight(prev => prev === group ? null : group);
    setTimeout(() => gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  // KPI: считаем по СТАТУСУ карточки (он уже учитывает peak-from-2024 и пр.).
  // «Растут» — только статус up. «Снижают» — crash/down/gone/paused (включая «не восст. от 2024»).
  // Сумма потерь/прироста — по deltaAbs (прогноз 2026 − факт 2025), чтобы loss+gain=net.
  const summary = useMemo(() => {
    const losing  = ds.clients.filter(c => ['crash', 'down', 'gone', 'paused'].includes(c.status));
    const gaining = ds.clients.filter(c => c.status === 'up');
    const newcomers = ds.clients.filter(c => c.status === 'new');
    const lossSum = losing.reduce((s, c) => s + (c.stats.deltaAbs || 0), 0);  // отрицательное
    const gainSum = gaining.reduce((s, c) => s + (c.stats.deltaAbs || 0), 0); // положительное
    const netDelta = lossSum + gainSum;
    const total2025 = ds.clients.reduce((s, c) => s + c.stats.revenue2025Full, 0);
    const totalForecast = ds.clients.reduce((s, c) => s + (c.stats.forecast2026 ?? c.stats.revenueYtd2026 * 2), 0);
    const netPct = total2025 > 0 ? netDelta / total2025 * 100 : null;
    return {
      losing: losing.length, gaining: gaining.length, newcomers: newcomers.length,
      lossSum, gainSum, netDelta, netPct,
      total2025, totalForecast,
    };
  }, []);

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-line">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-ink">VIP-клиенты · динамика 2024 → 2026</h1>
            <p className="text-sm text-muted mt-1">
              {ds.clients.length} ключевых клиентов S3-канала. Прогноз 2026 — сезонная экстраполяция YTD янв–май × (полный 2025 / YTD 2025). Источник: 1С / SQL Margin Cube.
            </p>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-muted uppercase tracking-wide">Данные на</div>
            <div className="text-sm font-medium text-ink tabular-nums">до {fmtMonth(ds.meta.lastFullMonth)} вкл.</div>
            <div className="text-[11px] text-muted">сгенерировано {ds.meta.generatedAt}</div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KPI
            label="🔴 Снижают объём"
            value={`${summary.losing}`}
            sub={`клиентов · теряют ${fmtRub(summary.lossSum)}`}
            tone="bad"
            hint="Клик — подсветить в гриде ниже. Включая «не восст. от 2024»."
            clickable
            active={highlight === 'losing'}
            onClick={() => handleKPIClick('losing')}
          />
          <KPI
            label="🟢 Растут"
            value={`${summary.gaining}`}
            sub={`клиентов · прибавляют ${fmtRub(summary.gainSum)}${summary.newcomers ? ` (+${summary.newcomers} новичков 2025)` : ''}`}
            tone="ok"
            hint="Клик — подсветить в гриде ниже. Чистый рост: и vs 2025, и vs пика 2024."
            clickable
            active={highlight === 'gaining'}
            onClick={() => handleKPIClick('gaining')}
          />
          <KPI
            label="Δ выручки к 2025"
            value={`${summary.netDelta >= 0 ? '+' : ''}${fmtRub(summary.netDelta)}`}
            sub={`= прирост ${fmtRub(summary.gainSum)} − потеря ${fmtRub(Math.abs(summary.lossSum))} (${fmtPct(summary.netPct)})`}
            tone={summary.netDelta >= 0 ? 'ok' : 'bad'}
            hint="Сумма изменений ВЫРУЧКИ топ-22: прогноз 2026 минус факт 2025. Не маржа."
          />
          <KPI
            label="Итого прогноз выручки 2026"
            value={fmtRub(summary.totalForecast)}
            sub={`2025 факт ${fmtRub(summary.total2025)}`}
            tone="info"
            hint="Сумма прогнозов выручки по всем 22 клиентам. Для новичков 2025 (без YoY-базы) — fallback YTD'26 × 2."
          />
        </div>

        {/* Причины падения — раскрывающийся блок */}
        <details className="bg-bad/5 rounded-xl ring-1 ring-bad/30 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-bad select-none flex items-center gap-2">
            🔴 Основные причины падения у клиентов (раскрыть)
          </summary>
          <div className="mt-4 text-sm text-ink space-y-3 leading-relaxed">
            <p className="text-muted">
              Тезисно — что слышим от менеджеров и клиентов в Q2 2026:
            </p>
            <ul className="list-disc pl-5 space-y-2.5">
              <li>
                <b>После уплаты налогов в Q1</b> у клиентов начались сокращения людей и проектов. Q1 2026 был неплохой, спад начался во втором квартале (по некоторым — раньше).
              </li>
              <li>
                <b>Большие стоки и упавшие продажи у клиентов</b> — ХЭЛСКЕА СОЛЮШНС: продажи упали, на складах остатки → нет потребности в новых заказах. Аналогично СМАРТ-СЭЙЛ по Ретинайту: «продажи без изменений, нет потребности».
              </li>
              <li>
                <b>Аннуляция крупных заказов</b> — НУОЛАБ 04.06.2026: одним письмом аннулированы прил.№22 (17 млн ₽) и №23 (8 млн ₽), всего ~25 млн ₽. SEMILY (СЭМИ КОСМЕТИК) 25.06.2026: официальное письмо с печатью — аннулировать прил.№8 «под пересмотр сезона».
              </li>
              <li>
                <b>Снижение тиражей в новом цикле планирования</b> — КОСМО БЬЮТИ (Likato) 23.06.2026: «скорректировали спецки в меньшую сторону на июль–август». НУОЛАБ: молочко CHA U SHINE смещено с июля на август.
              </li>
              <li>
                <b>Отказ от запуска новинок</b> — клиенты отказываются от старта новых продуктов: «не сможем конкурировать в нише» (ОКЕА: пенки O'CARE / HERO'S), Semily: «проекты подсократили сильно».
              </li>
              <li>
                <b>Перенос сроков</b> — СМАРТ-СЭЙЛ просит перенести изготовление на конец июня — середину июля.
              </li>
              <li>
                <b>Не восстановившиеся с 2024</b> — МАТРИКС (16% от пика), КЕАРЛИ (3%), БЕСТЛАНД (35%), КРЫГИНА (34%), Свиридова (29%): за 2025 уже упали, и за H1 2026 не дотягивают.
              </li>
              <li>
                <b>Полный уход</b> — ИНТЕГРАААЛ: последняя отгрузка февраль 2026.
              </li>
            </ul>
            <p className="pt-2 text-xs text-muted border-t border-bad/20">
              Источники: переписка с клиентами (см. карточки клиентов — скрины и заметки), официальные письма с печатью, наблюдения менеджеров.
            </p>
          </div>
        </details>

        {/* Explainer */}
        <details className="bg-white rounded-xl ring-1 ring-line p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink select-none">
            Как читать эти цифры
          </summary>
          <div className="mt-3 text-sm text-muted space-y-2 leading-relaxed">
            <p>
              Каждому клиенту посчитан <b className="text-ink">прогноз выручки 2026</b> = YTD янв–май 2026 × сезонный фактор (полный 2025 / YTD 2025). Сезонный фактор ограничен 2.5× — иначе клиент со стартом во второй половине 2025 раздул бы прогноз.
            </p>
            <p>
              <b className="text-ink">Δ к 2025</b> у клиента = прогноз 2026 − факт 2025 (в ₽).
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li><b>«Снижают объём»</b>: клиенты с отрицательной Δ. Их совокупная потеря к 2025 = {fmtRub(summary.lossSum)}.</li>
              <li><b>«Растут»</b>: клиенты с положительной Δ. Их совокупный прирост к 2025 = {fmtRub(summary.gainSum)}. Дополнительно {summary.newcomers} новичков 2025 (без YoY-базы) — у них Δ не считается.</li>
              <li><b>«Δ выручки к 2025»</b> = прирост у растущих − потеря у падающих. Положительное число значит «топ-20 в сумме растёт несмотря на падения». Отрицательное — «падения перевешивают». <span className="text-bad font-medium">Это изменение выручки, не маржи.</span></li>
              <li><b>«Итого прогноз выручки 2026»</b> = сумма прогнозов выручки по всем 20 клиентам. Для новичков 2025 (без YoY-базы) — fallback `YTD'26 × 2`. Сравнивается с фактом 2025.</li>
            </ul>
            <p className="pt-1 border-t border-line">
              <b className="text-ink">Важный нюанс:</b> рост у одних клиентов не компенсирует потерю от других в смысле бизнеса — это <i>разные клиенты, разные продукты, разные риски</i>. Нетто-цифра показывает «средняя температура по больнице», но для риск-менеджмента важна именно колонка «потеря у падающих» отдельно.
            </p>
          </div>
        </details>

        <YearlyComparisonChart
          aggregate={ds.aggregate}
          aggregateAll={ds.aggregateAll}
          totalVip={ds.meta.totalClients}
          totalAllS3={ds.meta.totalAllClientsS3}
          metric={metric}
          onMetricChange={setMetric}
        />

        <div ref={gridRef}>
          <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-lg font-semibold text-ink">
              VIP-клиенты ({ds.clients.length})
              {highlight && (
                <span className="ml-3 text-sm font-normal text-muted">
                  Подсвечены {highlight === 'losing' ? `снижающие (${summary.losing})` : `растущие (${summary.gaining})`} · <button onClick={() => setHighlight(null)} className="underline hover:text-ink">сбросить</button>
                </span>
              )}
            </h2>
            <div className="text-xs text-muted">Клик по карточке — детали + скрины</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {ds.clients.map(c => (
              <ClientCard
                key={c.slug}
                client={c}
                metric={metric}
                dimmed={!!highlightSet && !highlightSet.has(c.slug)}
                onClick={() => setOpenClient(c)}
              />
            ))}
          </div>
        </div>

        <footer className="text-xs text-muted py-6 text-center">
          margin-vip-clients · собирается из data.json (margin-daval-dashboard) · построено: {ds.meta.generatedAt}
        </footer>
      </main>

      <ClientModal client={openClient} open={!!openClient} onClose={() => setOpenClient(null)} />
    </div>
  );
}

function KPI({ label, value, sub, tone, hint, clickable, active, onClick }: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad' | 'info'; hint?: string; clickable?: boolean; active?: boolean; onClick?: () => void }) {
  const colorClass = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'info' ? 'text-info' : 'text-ink';
  const ringClass = active
    ? tone === 'bad' ? 'ring-2 ring-bad bg-bad/5' : tone === 'ok' ? 'ring-2 ring-ok bg-ok/5' : 'ring-2 ring-info bg-info/5'
    : 'ring-1 ring-line bg-white';
  const hoverClass = clickable ? 'hover:shadow-md hover:ring-2 hover:ring-ink/30 cursor-pointer transition' : '';
  const Tag = clickable ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`rounded-xl p-4 relative text-left w-full ${ringClass} ${hoverClass}`}
      title={hint}
    >
      <div className="text-[11px] text-muted uppercase tracking-wide flex items-center gap-1">
        <span>{label}</span>
        {hint && <span className="text-muted/60 text-[10px]">ⓘ</span>}
        {clickable && <span className="ml-auto text-[10px] text-muted">{active ? '✓ выбрано' : 'клик →'}</span>}
      </div>
      <div className={`text-2xl font-bold tabular-nums mt-1 ${colorClass}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </Tag>
  );
}
