import { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ChevronLeft, ChevronRight, FileText, ExternalLink } from 'lucide-react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ComposedChart } from 'recharts';
import type { ClientRecord, Metric } from '../types';
import { fmtRub, fmtQty, fmtPct, fmtMonth, fmtMonthLong, fmtValue, statusColors, lineColorForStatus } from '../format';
import meta from '../data/clientsMeta.json';

type Props = {
  client: ClientRecord | null;
  open: boolean;
  onClose: () => void;
};

const metricLabels: Record<Metric, string> = {
  revenue: 'Выручка ₽',
  qty: 'Количество шт',
  marginRub: 'Валовая маржа ₽',
};

export default function ClientModal({ client, open, onClose }: Props) {
  const [metric, setMetric] = useState<Metric>('revenue');
  const [shotIdx, setShotIdx] = useState(0);

  useEffect(() => { if (open) { setMetric('revenue'); setShotIdx(0); } }, [open, client?.slug]);

  if (!client) return null;

  const s = client.stats;
  const clientMeta = (meta as any).clients?.[client.slug] || { notes: '', screenshots: [] };
  const shots: { file: string; caption?: string }[] = clientMeta.screenshots || [];
  const ref2026 = client.monthly.find(d => d.month === '2026-01')?.month;
  const color = lineColorForStatus(client.status);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-40 animate-in fade-in" />
        <Dialog.Content className="fixed inset-2 md:inset-6 z-50 bg-soft rounded-2xl shadow-2xl overflow-auto focus:outline-none">
          <div className="sticky top-0 bg-soft/95 backdrop-blur z-10 px-6 py-4 border-b border-line flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs text-muted tabular-nums">#{client.rank} из топ-20</span>
                <span className={`text-xs px-2 py-0.5 rounded-md ring-1 ${statusColors[client.status]}`}>
                  {client.statusLabel}
                </span>
                <span className="text-xs text-muted">{client.topScheme}</span>
              </div>
              <Dialog.Title className="text-xl font-semibold text-ink mt-1">{client.name}</Dialog.Title>
              <Dialog.Description className="text-sm text-muted mt-0.5">
                Менеджер: {client.managers.join(' · ') || '—'} · период {client.firstMonth && fmtMonth(client.firstMonth)} – {client.lastMonth && fmtMonth(client.lastMonth)}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-2 text-muted hover:bg-line hover:text-ink transition" aria-label="Закрыть">
              <X size={20} />
            </Dialog.Close>
          </div>

          <div className="p-6 grid lg:grid-cols-3 gap-6">
            {/* Yearly summary */}
            <div className="lg:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label={`2024 (полный год)${s.peakYear === 2024 ? ' · ПИК' : ''}`} value={fmtRub(s.revenue2024Full)} sub={fmtQty(s.qty2024Full)} accent={s.peakYear === 2024 ? true : undefined} />
              <Stat label={`2025 (полный год)${s.peakYear === 2025 ? ' · ПИК' : ''}`} value={fmtRub(s.revenue2025Full)} sub={fmtQty(s.qty2025Full)} accent={s.peakYear === 2025 ? true : undefined} />
              <Stat label="2026 YTD (янв–май)" value={fmtRub(s.revenueYtd2026)} sub={s.ytdDeltaPct !== null ? `vs YTD 2025: ${fmtPct(s.ytdDeltaPct)}` : 'нет базы 2025'} />
              <Stat
                label={`Прогноз 2026${s.forecastCapped ? ' (оценочн.)' : s.forecastSource === 'naive' ? ' (naive H1×2)' : ''}`}
                value={s.forecast2026 !== null ? fmtRub(s.forecast2026) : '—'}
                sub={s.deltaPct !== null ? `Δ vs 2025: ${fmtPct(s.deltaPct)} (${fmtRub(s.deltaAbs)})` : '—'}
                accent={s.deltaPct !== null ? (s.deltaPct < -15 ? 'bad' : s.deltaPct > 15 ? 'ok' : undefined) : undefined}
              />
            </div>

            {/* Recovery from peak — особенно важно если peak=2024 */}
            {s.recoveryPct !== null && s.peakRevenue > 0 && (
              <div className={`lg:col-span-3 rounded-xl ring-1 p-4 ${
                s.recoveryPct < 50 ? 'bg-bad/5 ring-bad/30' : s.recoveryPct < 80 ? 'bg-warn/5 ring-warn/30' : 'bg-ok/5 ring-ok/30'
              }`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className="text-[11px] text-muted uppercase tracking-wide">Восстановление от пика ({s.peakYear})</div>
                    <div className={`text-xl font-bold tabular-nums mt-0.5 ${
                      s.recoveryPct < 50 ? 'text-bad' : s.recoveryPct < 80 ? 'text-warn' : 'text-ok'
                    }`}>
                      {s.recoveryPct.toFixed(0)}% от пика
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted">Прогноз 2026 vs пик {s.peakYear}</div>
                    <div className="text-base font-medium tabular-nums">
                      {fmtRub(s.forecast2026)} vs {fmtRub(s.peakRevenue)}
                      <span className={`ml-2 text-sm ${(s.deltaVsPeak || 0) < 0 ? 'text-bad' : 'text-ok'}`}>
                        Δ {fmtRub(s.deltaVsPeak)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Main chart */}
            <div className="lg:col-span-3 bg-white rounded-xl ring-1 ring-line p-5">
              <div className="flex items-start justify-between flex-wrap gap-3 mb-3">
                <div>
                  <h3 className="text-base font-semibold text-ink">Помесячно от первой отгрузки</h3>
                  <p className="text-xs text-muted mt-0.5">Серая линия — 2026-01 (разделитель года)</p>
                </div>
                <div className="flex gap-1 bg-soft rounded-lg p-1 ring-1 ring-line">
                  {(['revenue', 'qty', 'marginRub'] as Metric[]).map(m => (
                    <button
                      key={m}
                      onClick={() => setMetric(m)}
                      className={`px-3 py-1 text-xs rounded-md transition ${
                        m === metric ? 'bg-white shadow-sm text-ink font-medium ring-1 ring-line' : 'text-muted hover:text-ink'
                      }`}
                    >
                      {metricLabels[m]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={client.monthly} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="month" tickFormatter={fmtMonth} tick={{ fill: '#475569', fontSize: 11 }} />
                    <YAxis
                      tick={{ fill: '#475569', fontSize: 11 }}
                      tickFormatter={(v) => metric === 'qty' ? `${(v / 1000).toFixed(0)}к` : `${(v / 1_000_000).toFixed(1)}М`}
                    />
                    <Tooltip
                      labelFormatter={fmtMonthLong}
                      formatter={(v: number) => [fmtValue(metric, v), metricLabels[metric]]}
                      contentStyle={{ borderRadius: 8, border: '1px solid #E2E8F0', boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}
                    />
                    {ref2026 && <ReferenceLine x={ref2026} stroke="#94A3B8" strokeDasharray="4 4" label={{ value: '2026', position: 'top', fill: '#475569', fontSize: 11 }} />}
                    <Bar dataKey={metric} fill={color} fillOpacity={0.15} />
                    <Line type="monotone" dataKey={metric} stroke={color} strokeWidth={2.5} dot={{ r: 2.5, fill: color }} activeDot={{ r: 5 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* SKU + notes */}
            <div className="lg:col-span-1 bg-white rounded-xl ring-1 ring-line p-5">
              <h3 className="text-base font-semibold text-ink mb-3">Топ-3 SKU 2025</h3>
              {client.topSkus.length === 0 && <p className="text-sm text-muted">Нет данных</p>}
              <ol className="space-y-2">
                {client.topSkus.map((s, i) => (
                  <li key={s.sku} className="text-sm">
                    <div className="font-medium text-ink truncate">{i + 1}. {s.name}</div>
                    <div className="text-xs text-muted tabular-nums">{s.sku} · {fmtRub(s.revenue2025)}</div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="lg:col-span-2 bg-white rounded-xl ring-1 ring-line p-5">
              <h3 className="text-base font-semibold text-ink mb-3">Заметки</h3>
              <p className="text-sm text-muted whitespace-pre-wrap">
                {clientMeta.notes || (
                  <span className="italic">Пока пусто. Добавь через src/data/clientsMeta.json — поле "notes".</span>
                )}
              </p>
            </div>

            {/* Screenshots */}
            <div className="lg:col-span-3 bg-white rounded-xl ring-1 ring-line p-5">
              <h3 className="text-base font-semibold text-ink mb-3">Скрины переписок / договорённостей</h3>
              {shots.length === 0 && (
                <div className="text-sm text-muted">
                  Скрины не загружены. Положи файлы в <code className="bg-line px-1 py-0.5 rounded">public/clients/{client.slug}/</code> и пропиши в <code className="bg-line px-1 py-0.5 rounded">src/data/clientsMeta.json</code> поле <code className="bg-line px-1 py-0.5 rounded">screenshots: [{`{file, caption}`}]</code>.
                </div>
              )}
              {shots.length > 0 && (() => {
                const cur = shots[shotIdx];
                const url = `/clients/${client.slug}/${cur.file}`;
                const isPdf = /\.pdf$/i.test(cur.file);
                return (
                  <div className="space-y-3">
                    <div className="relative bg-soft rounded-lg ring-1 ring-line overflow-hidden min-h-[200px]">
                      {isPdf ? (
                        <div className="flex flex-col items-center justify-center p-12 gap-4">
                          <FileText size={64} className="text-bad/70" />
                          <div className="text-center">
                            <div className="text-base font-semibold text-ink">{cur.file}</div>
                            <div className="text-sm text-muted mt-1">PDF-документ — открыть в новой вкладке</div>
                          </div>
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-white rounded-md hover:bg-ink/90 transition text-sm"
                          >
                            <ExternalLink size={16} /> Открыть PDF
                          </a>
                        </div>
                      ) : (
                        <a href={url} target="_blank" rel="noopener noreferrer" title="Открыть в полном размере">
                          <img
                            src={url}
                            alt={cur.caption || ''}
                            className="w-full h-auto max-h-[60vh] object-contain mx-auto"
                          />
                        </a>
                      )}
                      {shots.length > 1 && (
                        <>
                          <button onClick={() => setShotIdx((shotIdx - 1 + shots.length) % shots.length)}
                                  className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/90 rounded-full p-2 shadow ring-1 ring-line hover:bg-white">
                            <ChevronLeft size={18} />
                          </button>
                          <button onClick={() => setShotIdx((shotIdx + 1) % shots.length)}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/90 rounded-full p-2 shadow ring-1 ring-line hover:bg-white">
                            <ChevronRight size={18} />
                          </button>
                        </>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-sm gap-3">
                      <span className="text-muted whitespace-nowrap">{shotIdx + 1} / {shots.length}</span>
                      {cur.caption && <span className="text-ink text-right">{cur.caption}</span>}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'ok' | 'bad' | true }) {
  const accentClass = accent === 'ok' ? 'text-ok' : accent === 'bad' ? 'text-bad' : accent ? 'text-ink' : 'text-ink';
  return (
    <div className="bg-white rounded-xl ring-1 ring-line p-4">
      <div className="text-[11px] text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-semibold tabular-nums mt-1 ${accentClass}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}
