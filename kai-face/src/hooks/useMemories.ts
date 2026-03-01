import { useState, useCallback } from "react";
import { apiGet, apiDelete } from "../api/client";

export interface Memory {
  id: string;
  content: string;
  importance: number;
  source: string;
  createdAt: string;
}

export function useMemories() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ memories: Memory[] }>("/memories");
      setMemories(res.memories);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await apiDelete(`/memories/${id}`);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch {
      // silent
    }
  }, []);

  return { memories, loading, fetch, remove };
}
