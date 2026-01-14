export interface RoutingBaseline {
  podName: string;
  bps: number; // integer, target sum = 10,000 (remainder goes to catch-all)
  updatedAtISO: string;
}

export interface RoutingOverride {
  id: string;
  podName: string;
  deltaBps: number; // integer, can be negative
  remainingDeposits?: number | null;
  expiresOn?: string | null; // YYYY-MM-DD
  reason?: string | null;
  createdBy?: string | null;
  allowProtectedReduction: boolean;
  createdAtISO: string;
}

export interface DepositPlanLine {
  podName: string;
  bps: number;
  amountDollars: number;
}

export interface DepositPlan {
  depositAmountDollars: number;
  lines: DepositPlanLine[];
  catchAllPodName: string;
  warnings: string[];
}

