export const fmtRub = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)} млн ₽`;
  if (abs >= 1_000)     return `${sign}${(abs / 1_000).toFixed(0)} тыс ₽`;
  return `${sign}${abs.toFixed(0)} ₽`;
};

export const fmtQty = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  return Math.round(v).toLocaleString('ru-RU') + ' шт';
};

export const fmtPct = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
};

export const fmtMonth = (ym: string): string => {
  const [y, m] = ym.split('-');
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${months[parseInt(m) - 1]} ${y.slice(2)}`;
};

export const fmtMonthLong = (ym: string): string => {
  const [y, m] = ym.split('-');
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${months[parseInt(m) - 1]} ${y}`;
};

export const fmtValue = (metric: 'revenue' | 'qty' | 'marginRub', v: number): string => {
  return metric === 'qty' ? fmtQty(v) : fmtRub(v);
};

export const statusColors: Record<string, string> = {
  gone:   'text-bad     bg-bad/10     ring-bad/20',
  crash:  'text-bad     bg-bad/10     ring-bad/20',
  down:   'text-warn    bg-warn/10    ring-warn/30',
  paused: 'text-warn    bg-warn/10    ring-warn/30',
  stable: 'text-muted   bg-line       ring-line',
  up:     'text-ok      bg-ok/10      ring-ok/30',
  new:    'text-info    bg-info/10    ring-info/30',
};

export const lineColorForStatus = (status: string): string => {
  switch (status) {
    case 'crash':
    case 'gone':   return '#DC2626';
    case 'down':
    case 'paused': return '#F59E0B';
    case 'up':     return '#16A34A';
    case 'new':    return '#2563EB';
    default:       return '#64748B';
  }
};
