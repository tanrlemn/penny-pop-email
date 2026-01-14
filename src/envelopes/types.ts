export type PriorityGroup =
  | "Savings"
  | "SafetyNet"
  | "Necessities"
  | "Pressing"
  | "Kiddos"
  | "Discretionary"
  | "Other";

export interface EnvelopeRule {
  id: string;
  name: string; // must match Sequence pod name
  monthlyBudgetDollars: number;
  dueByDay?: number | null; // 1-31
  dueAmountDollars?: number | null; // defaults to monthlyBudgetDollars
  bufferMonths: number; // >= 0
  priorityGroup: PriorityGroup;
  protected: boolean;
  updatedAtISO: string;
}

export interface EnvelopeState {
  name: string;
  balanceDollars: number | null;
  monthlyBudgetDollars: number;
  dueByDay?: number | null;
  dueAmountDollars: number;
  bufferMonths: number;
  requiredFloorDollars: number;
  requiredByDueDollars?: number; // required_floor + due_amount
  availableToSpendDollars: number | null; // null if balance null
  status: EnvelopeStatus;
  statusReason?: string;
  priorityGroup: PriorityGroup;
  protected: boolean;
}

export type EnvelopeStatus = "OK" | "buffer_breached" | "due_soon" | "overdue";

export type FixIssueType = "timing_shortfall" | "overspend" | "structural_underfund";

export interface DetectedIssue {
  type: FixIssueType;
  envelopeName: string;
  severity: "info" | "warn" | "error";
  shortfallDollars: number; // >= 0
  reason: string;
}

export type DecisionVocabulary = "RESTORE" | "ROUTING" | "STRUCTURAL";

export interface PlanStepTransfer {
  kind: "transfer";
  fromEnvelope: string;
  toEnvelope: string;
  amountDollars: number;
}

export interface PlanStepRoutingOverride {
  kind: "routing_override";
  envelope: string;
  deltaBps: number; // can be negative
  remainingDeposits: number;
}

export interface PlanStepRuleChange {
  kind: "rule_change";
  envelope: string;
  changes: Partial<Pick<EnvelopeRule, "monthlyBudgetDollars" | "bufferMonths" | "dueAmountDollars" | "dueByDay">>;
}

export type PlanStep = PlanStepTransfer | PlanStepRoutingOverride | PlanStepRuleChange;

export interface FixPlanOption {
  optionId: "A" | "B" | "C";
  label: string;
  vocabulary: DecisionVocabulary;
  summary: string;
  steps: PlanStep[];
  warnings?: string[];
}

export interface FixPlan {
  issue: DetectedIssue;
  options: FixPlanOption[];
  recommendedOptionId: "A" | "B" | "C";
}

