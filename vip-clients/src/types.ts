export type MonthlyPoint = {
  month: string;        // 'YYYY-MM'
  revenue: number;
  qty: number;
  marginRub: number;
};

export type ClientStats = {
  revenue2024Full: number;
  revenue2025Full: number;
  revenueYtd2025: number;
  revenueYtd2026: number;
  qty2024Full: number;
  qty2025Full: number;
  margin2024Full: number;
  margin2025Full: number;
  forecast2026: number | null;
  forecastSource?: 'seasonal' | 'naive' | 'none';
  forecastCapped: boolean;
  deltaAbs: number | null;
  deltaPct: number | null;
  ytdDeltaPct: number | null;
  peakRevenue: number;
  peakYear: number;
  recoveryPct: number | null;
  deltaVsPeak: number | null;
};

export type ClientStatus = 'gone' | 'new' | 'paused' | 'crash' | 'down' | 'up' | 'stable';

export type ClientRecord = {
  slug: string;
  name: string;
  displayName: string;
  rank: number;
  managers: string[];
  topScheme: string;
  firstMonth: string | null;
  lastMonth: string | null;
  monthly: MonthlyPoint[];
  stats: ClientStats;
  status: ClientStatus;
  statusLabel: string;
  topSkus: { sku: string; name: string; revenue2025: number }[];
  mergedFrom: string[];
};

export type Dataset = {
  meta: {
    generatedAt: string;
    sourceFile: string;
    sourceGeneratedAt: string;
    endDateExclusive: string;
    lastFullMonth: string;
    totalClients: number;
    totalAllClientsS3: number;
  };
  aggregate: MonthlyPoint[];         // только VIP топ-N
  aggregateAll: MonthlyPoint[];      // все клиенты S3-канала
  clients: ClientRecord[];
};

export type Metric = 'revenue' | 'qty' | 'marginRub';
