export type SequenceAccountType = "Account" | "Pod" | "Income Source";

export interface SequenceAccount {
  id: string;
  name: string;
  type: SequenceAccountType;
  balanceDollars: number | null; // null if unavailable
}

export interface Snapshot {
  date: string; // YYYY-MM-DD
  savingsTotal: number;
  partial?: boolean;
  missing?: string[]; // tracked savings accounts missing/unavailable today
}

export type AlertLevel = "RED" | "YELLOW";

export interface PersistedStateV1 {
  version: 1;
  snapshots: Snapshot[];
  lastAlert?: { level: AlertLevel; date: string } | null;
}

export type StatusLevel = "GREEN" | "YELLOW" | "RED";
export type ReasonCode = "UP" | "FLAT" | "DOWN" | "MISSING_DATA" | "BASELINE";

export interface Status {
  level: StatusLevel;
  reasonCode: ReasonCode;
  lookbackDays: number;
  delta?: number;
  slopePerDay?: number;
  projectedMonthly?: number;
  reason: string;
}


