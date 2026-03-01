import { useState, useEffect, useCallback } from "react";
import { rpc } from "../lib/gateway";

export type PowerSource = "local" | "custom" | "community";

export interface PowerArtifactDeclaration {
  key: string;
  label: string;
  type: string;
}

export interface PowerInfo {
  id: string;
  name: string;
  description: string;
  fileName: string;
  icon: string;
  category: string;
  source: PowerSource;
  enabled: boolean;
  dependsOn: string[];
  skills: string[];
  tools: string[];
  steps: string[];
  artifacts: PowerArtifactDeclaration[];
  output: string;
  available: boolean;
  missingIntegrations: string[];
}

export interface CommunityPowerInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  dependsOn: string[];
  steps: string[];
  installed: boolean;
}

export function usePowers() {
  const [powers, setPowers] = useState<PowerInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPowers = useCallback(async () => {
    try {
      setLoading(true);
      const result = await rpc<{ powers: PowerInfo[] }>("powers.list", {});
      setPowers(
        (result.powers ?? []).map((p) => ({
          ...p,
          fileName: p.fileName ?? "",
          source: p.source ?? "local",
          enabled: p.enabled ?? true,
          dependsOn: p.dependsOn ?? [],
          skills: p.skills ?? [],
          tools: p.tools ?? [],
          steps: p.steps ?? [],
          artifacts: p.artifacts ?? [],
          output: p.output ?? "",
          missingIntegrations: p.missingIntegrations ?? [],
        })),
      );
    } catch {
      setPowers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPowers();
  }, [fetchPowers]);

  const createPower = useCallback(async (params: {
    name: string;
    description: string;
    icon?: string;
    category?: string;
    dependsOn?: string[];
    steps?: string[];
  }): Promise<PowerInfo> => {
    const result = await rpc<{ power: PowerInfo }>("powers.create", params);
    await fetchPowers();
    return result.power;
  }, [fetchPowers]);

  const installPower = useCallback(async (powerId: string): Promise<PowerInfo> => {
    const result = await rpc<{ power: PowerInfo }>("powers.install", { powerId });
    await fetchPowers();
    return result.power;
  }, [fetchPowers]);

  return { powers, loading, refetch: fetchPowers, createPower, installPower };
}

export function useCommunityPowers() {
  const [powers, setPowers] = useState<CommunityPowerInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCommunity = useCallback(async () => {
    try {
      setLoading(true);
      const result = await rpc<{ powers: CommunityPowerInfo[] }>("powers.community", {});
      setPowers(result.powers ?? []);
    } catch {
      setPowers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCommunity();
  }, [fetchCommunity]);

  return { powers, loading, refetch: fetchCommunity };
}
