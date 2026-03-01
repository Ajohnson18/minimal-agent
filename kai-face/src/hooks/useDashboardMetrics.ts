import { useState, useEffect, useCallback } from "react";
import { rpc } from "../lib/gateway";

export interface DashboardArtifact {
  id: string;
  powerId: string;
  powerName: string;
  key: string;
  label: string;
  artifactType: string;
  data: unknown;
  icon: string | null;
  lastRunId: string | null;
  updatedAt: number;
  createdAt: number;
}

/** @deprecated Use DashboardArtifact instead */
export type DashboardMetric = DashboardArtifact;

export function useDashboardMetrics() {
  const [metrics, setMetrics] = useState<DashboardArtifact[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    try {
      setLoading(true);
      const resp = await rpc<{ metrics: DashboardArtifact[] }>("metrics.list", {});
      setMetrics(resp.metrics ?? []);
    } catch {
      setMetrics([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const deleteMetric = useCallback(async (id: string) => {
    try {
      await rpc("metrics.delete", { id });
      setMetrics((prev) => prev.filter((m) => m.id !== id));
    } catch {}
  }, []);

  return { metrics, loading, refetch: fetchMetrics, deleteMetric };
}
