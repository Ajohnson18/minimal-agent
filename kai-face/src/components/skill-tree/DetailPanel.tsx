import { useState } from "react";
import type { SkillNode } from "../../lib/skill-tree-data";
import { apiDelete } from "../../api/client";
import SecretInput from "../ui/SecretInput";
import IntegrationRow from "./IntegrationRow";
import SkillRow from "./SkillRow";

interface Props {
  node: SkillNode;
  nodes: SkillNode[];
  nodeMap: Map<string, SkillNode>;
  onClose: () => void;
  onSelectNode: (id: string) => void;
  onReload: () => void | Promise<void>;
}

export default function DetailPanel({ node, nodes, nodeMap, onClose, onSelectNode, onReload }: Props) {
  return (
    <div className="absolute right-4 top-4 w-[min(384px,30vw)] min-w-[260px] rounded-xl border border-gray-700 bg-gray-900/95 backdrop-blur-sm p-6 shadow-2xl z-10 overflow-y-auto max-h-[80vh]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {node.type === "integration" && (
            <div className={`h-9 w-9 rounded-lg border-2 flex items-center justify-center text-xs font-bold shrink-0 ${
              node.status === "active" ? "border-green-500 text-green-400 bg-green-500/10" : "border-gray-600 text-gray-500 bg-gray-800"
            }`}>{node.logoChar ?? node.label.slice(0, 2)}</div>
          )}
          <div>
            <h3 className="text-lg font-semibold text-white">{node.label}</h3>
            <span className="text-xs text-gray-500 uppercase tracking-wider">
              {node.type === "integration" ? "Integration" : node.type === "skill" ? "Skill" : node.type}
            </span>
          </div>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">×</button>
      </div>

      <p className="text-sm text-gray-400 mb-4 leading-relaxed">{node.description}</p>

      {node.type === "branch" && <BranchDetail node={node} nodes={nodes} nodeMap={nodeMap} onSelectNode={onSelectNode} />}
      {node.type === "integration" && <IntegrationDetail node={node} nodes={nodes} onReload={onReload} onClose={onClose} />}

      {node.tools && node.tools.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2.5">Tools</h4>
          <div className="space-y-2">
            {node.tools.map((t) => (
              <div key={t.name} className="flex items-start gap-2.5 rounded-lg bg-gray-800/50 px-3 py-2.5">
                <span className="font-mono text-sm text-blue-400 shrink-0">{t.name}</span>
                <span className="text-sm text-gray-500">{t.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BranchDetail({ node, nodes, nodeMap, onSelectNode }: {
  node: SkillNode; nodes: SkillNode[]; nodeMap: Map<string, SkillNode>; onSelectNode: (id: string) => void;
}) {
  const intgs = nodes.filter((n) => n.parentId === node.id && n.type === "integration");
  const skills = nodes.filter((n) => n.branch === node.id && n.type === "skill");

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2.5">Integrations</h4>
        <div className="space-y-2">
          {intgs.map((i) => <IntegrationRow key={i.id} node={i} onClick={() => onSelectNode(i.id)} />)}
        </div>
      </div>
      {skills.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2.5">Skills</h4>
          <div className="space-y-1.5">
            {skills.map((s) => (
              <SkillRow key={s.id} node={s} requiresLabel={s.requiresIntegration ? nodeMap.get(s.requiresIntegration)?.label : undefined} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IntegrationDetail({ node, nodes, onReload, onClose }: {
  node: SkillNode; nodes: SkillNode[]; onReload: () => void | Promise<void>; onClose: () => void;
}) {
  const [showUpdate, setShowUpdate] = useState(false);
  const [removing, setRemoving] = useState(false);
  const dependentSkills = nodes.filter((n) => n.requiresIntegration === node.id && n.type === "skill");

  async function handleRemove() {
    if (!node.credentialKey) return;
    setRemoving(true);
    try {
      await apiDelete(`/me/credentials/${node.credentialKey}`);
      await onReload();
    } catch {
      // silently fail
    } finally {
      setRemoving(false);
    }
  }

  if (node.status === "active" && !showUpdate) {
    return (
      <div className="mb-4 space-y-2">
        <div className="rounded-lg bg-green-900/20 border border-green-700/40 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <p className="text-sm text-green-400 font-medium">Connected</p>
            {node.credentialKey && (
              <p className="text-[11px] text-gray-500 font-mono">{node.credentialKey.toUpperCase()}</p>
            )}
          </div>
        </div>
        {node.credentialKey && (
          <div className="flex gap-2">
            <button
              onClick={() => setShowUpdate(true)}
              className="flex-1 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
            >
              Update key
            </button>
            <button
              onClick={handleRemove}
              disabled={removing}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:border-red-700 transition-colors disabled:opacity-40"
            >
              {removing ? "Removing..." : "Remove"}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!node.credentialKey) {
    return (
      <div className="rounded-lg bg-green-900/20 border border-green-800/40 px-3 py-2 mb-3">
        <p className="text-sm text-green-400">No credentials needed</p>
      </div>
    );
  }

  return (
    <div className="mb-4">
      {dependentSkills.length > 0 && (
        <div className="rounded-lg bg-gray-800 px-3 py-2.5 mb-3">
          <p className="text-sm text-gray-300 mb-1.5">
            {showUpdate ? "Update your key:" : "Add your API key to unlock:"}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {dependentSkills.map((s) => (
              <span key={s.id} className="rounded-full bg-gray-700 px-2.5 py-0.5 text-xs text-gray-400">{s.label}</span>
            ))}
          </div>
        </div>
      )}
      <SecretInput credentialKey={node.credentialKey} onSaved={() => { onReload(); onClose(); }} />
      {showUpdate && (
        <button
          onClick={() => setShowUpdate(false)}
          className="mt-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
