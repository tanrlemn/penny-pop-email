import { handleSequenceRemoteApi } from "../src/routing/sequenceRemoteApiHandler";

export default async function handler(req: any, res: any) {
  try {
    const result = await handleSequenceRemoteApi({
      method: req.method,
      headers: req.headers ?? {},
      query: req.query ?? {},
      body: req.body ?? {},
    });
    res.status(result.status).json(result.json);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Internal error" });
  }
}

