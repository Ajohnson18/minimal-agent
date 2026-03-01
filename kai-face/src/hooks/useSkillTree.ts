import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSkillTree } from "../api/setup";
import { type SkillNode } from "../lib/skill-tree-data";
import { type OnboardPhase } from "../components/skill-tree/SkillTree";
import { mapNodes, derivePhase } from "../utils/skill-tree-utils";
import { ensureConnected, rpc, subscribe } from "../lib/gateway";

const NEW_NODE_TTL_MS = 6000;

export function useSkillTree() {
  const queryClient = useQueryClient();
  const [nodes, setNodes] = useState<SkillNode[]>([]);
  const [phase, setPhase] = useState<OnboardPhase>("brain");
  const [newNodeIds, setNewNodeIds] = useState<Set<string>>(new Set());
  const pendingNewIds = useRef<Set<string>>(new Set());

  const { isLoading, isError } = useQuery({
    queryKey: ["skill-tree"],
    queryFn: async () => {
      const data = await getSkillTree();
      const mapped = mapNodes(data.nodes);
      setNodes(mapped);
      setPhase(derivePhase(mapped));

      if (pendingNewIds.current.size > 0) {
        const arriving = new Set(pendingNewIds.current);
        pendingNewIds.current.clear();
        setNewNodeIds(arriving);
        setTimeout(() => setNewNodeIds((prev) => {
          const next = new Set(prev);
          arriving.forEach((id) => next.delete(id));
          return next;
        }), NEW_NODE_TTL_MS);
      }

      return data;
    },
  });

  useEffect(() => {
    ensureConnected();
    rpc("subscribe", { events: ["skill-tree.updated"] }).catch(console.error);
    const unsub = subscribe((event) => {
      if (event.event === "skill-tree.updated" && event.payload.action === "registered") {
        pendingNewIds.current.add(event.payload.nodeId as string);
        queryClient.invalidateQueries({ queryKey: ["skill-tree"] });
      }
    });
    return unsub;
  }, [queryClient]);

  const reload = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["skill-tree"] });
  }, [queryClient]);

  return { nodes, setNodes, phase, setPhase, newNodeIds, isLoading, isError, reload };
}
