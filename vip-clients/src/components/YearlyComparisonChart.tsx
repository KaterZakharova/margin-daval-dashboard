import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { MonthlyPoint, Metric } from '../types';
import { fmtValue, fmtMonth, fmtMonthLong } from '../format';

type Scope = 'vip' | 'all';
type ViewMode = 'overlay' | 'timeline';

type Props = {
  aggregate: MonthlyPoint[];          // VIP топ-22
  aggregateAll: MonthlyPoint[];       // все клиенты S3
  totalVip: number;
  totalAllS3: number;
  metric: Metric;
  onMetricChange: (m: Metric) => void;
};

const monthLabels = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const metricLabels: Record<Metric, string> = {
  revenue: 'Выручка ₽',
  qty: 'Количество шт',
  marginRub: 'Валовая маржа ₽',
};

const yearColors: Record<number, string> = {
  2024: '#94A3B8',  // нейтрально-серый
  2025: '#2563EB',  // info blue (база)
  2026: '#DC2626',  // акцент — текущая ситуация
};

export default function YearlyComparisonChart({ aggregate, aggregateAll, totalVip, totalAllS3, metric, onMetricChange }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('overlay');
  const [scope, setScope] = useState<Scope>('vip');
  const [visibleYears, setVisibleYears] = useState<Set<number>>(new Set([2024, 2025, 2026]));
  const source = scope === 'vip' ? aggregate : aggregateAll;
  const totalAcross = source.reduce((s, d) => s + d[metric], 0);
  const ref2025 = source.find(d => d.month === '2025-01')?.month;
  const ref2026 = source.find(d => d.month === '2026-01')?.month;
  const toggleYear = (y: number) => {
    setVisibleYears(prev => {
      const n = new Set(prev);
      if (n.has(y)) {
        if (n.size > 1) n.delete(y);   // не даём отключить последний
      } else n.add(y);
      return n;
    });
  };

  // pivot: один объект на месяц 1..12, поля y2024/y2025/y2026
  const data = monthLabels.map((label, idx) => {
    const mNum = idx + 1;
    const point: any = { month: label, monthNum: mNum };
    for (const y of [2024, 2025, 2026]) {
      const ym = `${y}-${String(mNum).padStart(2, '0')}`;
      const a = source.find(x => x.month === ym);
      point[`y${y}`] = a ? a[metric] : null;
    }
    return point;
  });

  // суммы за каждый год для подписи
  const totals: Record<number, number> = { 2024: 0, 2025: 0, 2026: 0 };
  for (const y of [2024, 2025, 2026]) {
    totals[y] = data.reduce((s, d) => s + (d[`y${y}`] ?? 0), 0);
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm ring-1 ring-line p-6">
      {/* Tabs: viewMode */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4 border-b border-line">
        <div className="flex gap-1 -mb-px">
          {([['overlay', 'Наложение по месяцам'], ['timeline', 'Сквозной 2024 → 2026']] as [ViewMode, string][]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              className={`px-4 py-2.5 text-sm font-medium transition border-b-2 ${
                viewMode === v
                  ? 'text-ink border-info'
                  : 'text-muted border-transparent hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-soft rounded-lg p-1 ring-1 ring-line mb-2">
          {(['revenue', 'qty', 'marginRub'] as Metric[]).map(m => (
            <button
              key={m}
              onClick={() => onMetricChange(m)}
              className={`px-3 py-1.5 text-sm rounded-md transition ${
                m === metric ? 'bg-white shadow-sm text-ink font-medium ring-1 ring-line' : 'text-muted hover:text-ink'
              }`}
            >
              {metricLabels[m]}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <p className="text-sm text-muted">
          {viewMode === 'overlay'
            ? <>Наложение трёх лет по месяцам — видно точку перелома 2026 vs 2024/2025.</>
            : <>Сквозной тренд от первой отгрузки до последнего закрытого месяца. Итого за весь период: <span className="font-medium text-ink">{fmtValue(metric, totalAcross)}</span>.</>}
        </p>
      </div>

      {/* Scope toggle — крупные яркие буллиты слева */}
      <div className="flex flex-wrap gap-3 mb-4">
        {(['vip', 'all'] as Scope[]).map(s => {
          const active = scope === s;
          const label = s === 'vip'
            ? <>По <span className="font-semibold">VIP клиентам</span> <span className="text-muted text-xs ml-1">({totalVip})</span></>
            : <>По <span className="font-semibold">всем клиентам</span> <span className="text-muted text-xs ml-1">({totalAllS3} в S3-канале)</span></>;
          return (
            <label
              key={s}
              className={`flex items-center gap-2.5 cursor-pointer px-3.5 py-2 rounded-full ring-2 transition select-none ${
                active
                  ? 'ring-info bg-info/10 text-ink'
                  : 'ring-line bg-white text-muted hover:ring-info/40 hover:text-ink'
              }`}
            >
              <input
                type="radio"
                name="scope"
                value={s}
                checked={active}
                onChange={() => setScope(s)}
                className="sr-only"
              />
              <span className={`w-5 h-5 rounded-full ring-2 flex items-center justify-center transition ${
                active ? 'ring-info bg-info' : 'ring-line bg-white'
              }`}>
                {active && <span className="w-2 h-2 rounded-full bg-white" />}
              </span>
              <span className="text-sm">{label}</span>
            </label>
          );
        })}
      </div>

      {/* Итоги по годам — кликабельные чипы (только в режиме «Наложение») */}
      {viewMode === 'overlay' && <div className="flex flex-wrap gap-2 mb-4">
        <span className="text-xs text-muted self-center mr-1">Годы:</span>
        {[2024, 2025, 2026].map(y => {
          const on = visibleYears.has(y);
          return (
            <button
              key={y}
              onClick={() => toggleYear(y)}
              className={`flex items-center gap-2.5 px-3 py-1.5 rounded-full ring-2 transition select-none text-sm ${
                on ? 'bg-white text-ink' : 'bg-soft text-muted/60 line-through opacity-60'
              }`}
              style={{ borderColor: on ? yearColors[y] : '#E2E8F0', boxShadow: on ? `inset 0 0 0 2px ${yearColors[y]}` : 'inset 0 0 0 2px #E2E8F0' }}
              title={on ? `Скрыть ${y}` : `Показать ${y}`}
            >
              <span className="w-3 h-3 rounded-full" style={{ background: yearColors[y] }} />
              <span className="font-medium tabular-nums">
                {y}{y === 2026 ? ' (янв–май)' : ''}
              </span>
              <span className="text-muted text-xs tabular-nums">{fmtValue(metric, totals[y])}</span>
            </button>
          );
        })}
        <span className="text-[11px] text-muted self-center ml-1">клик — скрыть/показать</span>
      </div>}

      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          {viewMode === 'overlay' ? (
            <LineChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 11 }} />
              <YAxis
                tick={{ fill: '#475569', fontSize: 11 }}
                tickFormatter={(v) => metric === 'qty' ? `${(v / 1000).toFixed(0)}к` : `${(v / 1_000_000).toFixed(0)}М`}
              />
              <Tooltip
                formatter={(v: any, name: any) => v == null ? ['—', String(name)] : [fmtValue(metric, Number(v)), String(name)]}
                labelFormatter={(label) => `Месяц: ${label}`}
                contentStyle={{ borderRadius: 8, border: '1px solid #E2E8F0', boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}
              />
              <Legend verticalAlign="bottom" iconType="line" wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              {visibleYears.has(2024) && <Line type="monotone" dataKey="y2024" name="2024" stroke={yearColors[2024]} strokeWidth={2}   dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} />}
              {visibleYears.has(2025) && <Line type="monotone" dataKey="y2025" name="2025" stroke={yearColors[2025]} strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} />}
              {visibleYears.has(2026) && <Line type="monotone" dataKey="y2026" name="2026" stroke={yearColors[2026]} strokeWidth={3}   dot={{ r: 4 }} activeDot={{ r: 6 }} connectNulls={false} />}
            </LineChart>
          ) : (
            <LineChart data={source} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis
                dataKey="month"
                tickFormatter={fmtMonth}
                tick={{ fill: '#475569', fontSize: 11 }}
              />
              <YAxis
                tick={{ fill: '#475569', fontSize: 11 }}
                tickFormatter={(v) => metric === 'qty' ? `${(v / 1000).toFixed(0)}к` : `${(v / 1_000_000).toFixed(0)}М`}
              />
              <Tooltip
                labelFormatter={fmtMonthLong}
                formatter={(v: any) => [fmtValue(metric, Number(v)), metricLabels[metric]]}
                contentStyle={{ borderRadius: 8, border: '1px solid #E2E8F0', boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}
              />
              {ref2025 && <ReferenceLine x={ref2025} stroke="#94A3B8" strokeDasharray="4 4" label={{ value: '2025', position: 'top', fill: '#475569', fontSize: 11 }} />}
              {ref2026 && <ReferenceLine x={ref2026} stroke="#94A3B8" strokeDasharray="4 4" label={{ value: '2026', position: 'top', fill: '#475569', fontSize: 11 }} />}
              <Line
                type="monotone"
                dataKey={metric}
                stroke="#0F172A"
                strokeWidth={2.5}
                dot={{ r: 2.5, fill: '#0F172A' }}
                activeDot={{ r: 5, fill: '#0F172A' }}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
