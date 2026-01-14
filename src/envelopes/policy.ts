import { EnvelopeState, PriorityGroup } from "./types";

export const defaultBorrowOrder: PriorityGroup[] = [
  "Discretionary",
  "Pressing",
  "Necessities",
  "Kiddos",
  "Savings",
  "SafetyNet",
  "Other",
];

export function groupRank(group: PriorityGroup): number {
  const idx = defaultBorrowOrder.indexOf(group);
  return idx === -1 ? defaultBorrowOrder.length : idx;
}

export function canBorrowFromDonor(opts: {
  donor: EnvelopeState;
  allowSafetyNet?: boolean;
  allowProtectedReduction?: boolean;
}): { ok: boolean; reason?: string } {
  const { donor, allowSafetyNet = false, allowProtectedReduction = false } = opts;

  if (donor.balanceDollars == null || donor.availableToSpendDollars == null) {
    return { ok: false, reason: "Missing balance." };
  }

  if (donor.status === "due_soon" || donor.status === "overdue") {
    return { ok: false, reason: "Donor has a due-date requirement." };
  }

  if (donor.availableToSpendDollars <= 0) {
    return { ok: false, reason: "No surplus above buffer floor." };
  }

  if (donor.priorityGroup === "SafetyNet" && !allowSafetyNet) {
    return { ok: false, reason: "Safety Net is locked unless explicitly allowed." };
  }

  // If the donor is explicitly SafetyNet-allowed, treat that as permission to reduce it
  // (Safety Net is typically also marked protected).
  if (donor.protected && !allowProtectedReduction && !(donor.priorityGroup === "SafetyNet" && allowSafetyNet)) {
    return { ok: false, reason: "Protected envelope is locked unless explicitly allowed." };
  }

  return { ok: true };
}

