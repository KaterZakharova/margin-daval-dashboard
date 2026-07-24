import { LineChart, Line, ResponsiveContainer, YAxis, ReferenceLine } from 'recharts';
import type { ClientRecord, Metric } from '../types';
import { fmtRub, fmtQty, fmtPct, lineColorForStatus, statusColors, fmtMonth } from '../format';

type Props = {
  client: ClientRecord;
  metric: Metric;
  dimmed?: boolean;
  onClick: () => void;
};

export default function ClientCard({ client, metric, dimmed, onClick }: Props) {
  const s = client.stats;
  const color = lineColorForStatus(client.status);
  const ref2026 = client.monthly.find(d => d.month === '2026-01')?.month;

  // pick headline number based on status
  const headline = client.status === 'new'
    ? `${fmtRub(s.revenue2025Full)} в 2025`
    : s.deltaPct !== null
      ? `${fmtPct(s.deltaPct)} к 2025`
      : 'нет данных';

  return (
    <button
      onClick={onClick}
      className={`text-left bg-white rounded-xl ring-1 p-4 transition group focus:outline-none focus:ring-2 focus:ring-info ${
        dimmed
          ? 'ring-line opacity-30 hover:opacity-60'
          : 'ring-line hover:ring-ink/40 hover:shadow-md'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-muted tabular-nums">#{client.rank}</div>
          <h3 className="text-sm font-semibold text-ink truncate">{client.displayName}</h3>
        </div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-md ring-1 whitespace-nowrap ${statusColors[client.status] || statusColors.stable}`}>
          {client.statusLabel}
        </span>
      </div>

      <div className="h-16 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={client.monthly} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <YAxis hide domain={[0, 'dataMax']} />
            {ref2026 && <ReferenceLine x={ref2026} stroke="#CBD5E1" strokeDasharray="3 3" />}
            <Line
              type="monotone"
              dataKey={metric}
              stroke={color}
              strokeWidth={1.8}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <div>
          <div className="text-[10px] text-muted uppercase tracking-wide">Прогноз 2026</div>
          <div className="text-sm font-medium text-ink tabular-nums">
            {s.forecast2026 !== null ? fmtRub(s.forecast2026) : '—'}
            {s.forecastCapped && <span className="text-[9px] text-muted ml-1">оц.</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-muted uppercase tracking-wide">{client.status === 'new' ? '' : 'Δ vs 2025'}</div>
          <div className={`text-sm font-medium tabular-nums ${
            client.status === 'crash' || client.status === 'gone' || client.status === 'down' ? 'text-bad' :
            client.status === 'up' ? 'text-ok' :
            client.status === 'new' ? 'text-info' : 'text-muted'
          }`}>
            {headline}
          </div>
        </div>
      </div>

      <div className="mt-2 text-[10px] text-muted truncate">
        {client.firstMonth && client.lastMonth && (
          <>{fmtMonth(client.firstMonth)} – {fmtMonth(client.lastMonth)} · {client.managers[0] || 'без менеджера'}</>
        )}
      </div>
    </button>
  );
}
