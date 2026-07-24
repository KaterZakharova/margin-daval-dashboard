import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { MonthlyPoint, Metric } from '../types';
import { fmtMonth, fmtMonthLong, fmtValue } from '../format';

type Scope = 'vip' | 'all';

type Props = {
  data: MonthlyPoint[];         // VIP топ-N
  dataAll: MonthlyPoint[];      // все клиенты S3
  totalVip: number;
  totalAllS3: number;
  metric: Metric;
  onMetricChange: (m: Metric) => void;
};

const metricLabels: Record<Metric, string> = {
  revenue: 'Выручка ₽',
  qty: 'Количество шт',
  marginRub: 'Валовая маржа ₽',
};

export default function HeroChart({ data, dataAll, totalVip, totalAllS3, metric, onMetricChange }: Props) {
  const [scope, setScope] = useState<Scope>('vip');
  const source = scope === 'vip' ? data : dataAll;
  const ref2025 = source.find(d => d.month === '2025-01')?.month;
  const ref2026 = source.find(d => d.month === '2026-01')?.month;
  const total = source.reduce((s, d) => s + d[metric], 0);

  return (
    <div className="bg-white rounded-2xl shadow-sm ring-1 ring-line p-6">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Сквозной тренд 2024 → 2026</h2>
          <p className="text-sm text-muted mt-0.5">
            Помесячно от первой отгрузки до последнего закрытого месяца. Итого за весь период: <span className="font-medium text-ink">{fmtValue(metric, total)}</span>
          </p>
        </div>
        <div className="flex gap-1 bg-soft rounded-lg p-1 ring-1 ring-line">
          {(['revenue', 'qty', 'marginRub'] as Metric[]).map(m => (
            <button
              key={m}
              onClick={() => onMetricChange(m)}
              className={`px-3 py-1.5 text-sm rounded-md transition ${
                m === metric
                  ? 'bg-white shadow-sm text-ink font-medium ring-1 ring-line'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {metricLabels[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Scope toggle — яркие буллиты */}
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
                name="hero-scope"
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
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={source} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
            <XAxis
              dataKey="month"
              tickFormatter={fmtMonth}
              tick={{ fill: '#475569', fontSize: 11 }}
              axisLine={{ stroke: '#CBD5E1' }}
              tickLine={{ stroke: '#CBD5E1' }}
            />
            <YAxis
              tick={{ fill: '#475569', fontSize: 11 }}
              axisLine={{ stroke: '#CBD5E1' }}
              tickLine={{ stroke: '#CBD5E1' }}
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
        </ResponsiveContainer>
      </div>
    </div>
  );
}
