import assert from "node:assert/strict";
import { EnvelopeRule } from "../envelopes/types";
import { buildEnvelopeMatchIndex, extractMentionedEnvelopes, extractTransfer } from "../emailFixit/parseEmail";

const rules: EnvelopeRule[] = [
  {
    id: "move-to",
    name: "Move to ___",
    aliases: ["move to", "move to __", "move to ___"],
    monthlyBudgetDollars: 0,
    bufferMonths: 0,
    priorityGroup: "Other",
    protected: false,
    updatedAtISO: "",
  },
  {
    id: "health",
    name: "Health",
    aliases: ["health"],
    monthlyBudgetDollars: 0,
    bufferMonths: 0,
    priorityGroup: "Other",
    protected: false,
    updatedAtISO: "",
  },
  {
    id: "groceries",
    name: "Groceries",
    monthlyBudgetDollars: 0,
    bufferMonths: 0,
    priorityGroup: "Other",
    protected: false,
    updatedAtISO: "",
  },
  {
    id: "education",
    name: "Education",
    monthlyBudgetDollars: 0,
    bufferMonths: 0,
    priorityGroup: "Other",
    protected: false,
    updatedAtISO: "",
  },
];

const matchIndex = buildEnvelopeMatchIndex(rules);

function assertTransfer(text: string, expected: { amount?: number; from?: string; to?: string }) {
  const transfer = extractTransfer(text, matchIndex);
  assert.ok(transfer, `Expected transfer for: ${text}`);
  if (typeof expected.amount === "number") {
    assert.equal(transfer?.amount, expected.amount, `amount mismatch for: ${text}`);
  }
  if (expected.from) {
    assert.equal(transfer?.from, expected.from, `from mismatch for: ${text}`);
  }
  if (expected.to) {
    assert.equal(transfer?.to, expected.to, `to mismatch for: ${text}`);
  }
}

assertTransfer('I moved $220 from “Move to ___” to “health”', { amount: 220, from: "Move to ___", to: "Health" });
assertTransfer("Moved $20 from Move to __ to Health", { amount: 20, from: "Move to ___", to: "Health" });
assertTransfer("Groceries -> Education $15", { amount: 15, from: "Groceries", to: "Education" });
assertTransfer("moved 80 from Groceries to Education", { amount: 80, from: "Groceries", to: "Education" });

const mentioned = extractMentionedEnvelopes('I moved from “Move to ___” to health', matchIndex);
assert.deepEqual(mentioned, ["Move to ___", "Health"]);

console.log("testFixitTransferParsing: all checks passed");
