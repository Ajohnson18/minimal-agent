import { useState, useEffect, useCallback } from "react";
import { rpc } from "../lib/gateway";

export interface PowerRunResult {
  type: string;
  [key: string]: unknown;
}

export interface PowerRun {
  id: string;
  powerId: string;
  powerName: string;
  runId: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  result: PowerRunResult | null;
}

export function usePowerRuns(powerId?: string) {
  const [runs, setRuns] = useState<PowerRun[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRuns = useCallback(async () => {
    try {
      setLoading(true);
      const resp = await rpc<{ runs: PowerRun[] }>("powers.runs", { limit: 20, powerId });
      setRuns(resp.runs ?? []);
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [powerId]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  return { runs, loading, refetch: fetchRuns };
}
