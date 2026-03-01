import { useSkillTree } from "../hooks/useSkillTree";
import SkillTree from "../components/skill-tree/SkillTree";

export default function SkillsPage() {
  const { nodes, setNodes, phase, setPhase, newNodeIds, isLoading, isError, reload } = useSkillTree();

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-950">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-blue-500" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-950">
        <p className="text-gray-500 text-sm">Failed to load skill tree</p>
      </div>
    );
  }

  return (
    <SkillTree
      nodes={nodes}
      phase={phase}
      newNodeIds={newNodeIds}
      onNodesChange={setNodes}
      onPhaseChange={setPhase}
      onReload={reload}
    />
  );
}
