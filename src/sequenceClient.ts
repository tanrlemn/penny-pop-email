import { SequenceAccount, SequenceAccountType } from "./types";
import { config } from "./config";

type RawSequenceAccount = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  balance?: { amountInDollars?: unknown } | null;
};

function isSequenceAccountType(t: unknown): t is SequenceAccountType {
  return t === "Account" || t === "Pod" || t === "Income Source";
}

export async function fetchAccounts(): Promise<SequenceAccount[]> {
  const token = process.env.SEQ_TOKEN;
  if (!token) throw new Error("Missing SEQ_TOKEN env var");

  const res = await fetch(config.sequence.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sequence-access-token": `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    throw new Error(`Sequence API error: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as any;
  const raw: RawSequenceAccount[] = json?.data?.accounts ?? [];

  return raw.map((a) => {
    const balance =
      typeof a?.balance?.amountInDollars === "number" ? a.balance.amountInDollars : null;

    const type: SequenceAccountType = isSequenceAccountType(a?.type) ? a.type : "Account";

    return {
      id: String(a?.id ?? ""),
      name: String(a?.name ?? ""),
      type,
      balanceDollars: balance,
    };
  });
}


