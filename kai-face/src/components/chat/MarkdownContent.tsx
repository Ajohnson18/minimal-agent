import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const plugins = [remarkGfm];

const components: Components = {
  h1: ({ children }) => <h1 className="text-base font-bold text-gray-100 mt-3 mb-1.5">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-bold text-gray-100 mt-3 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-200 mt-2 mb-1">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed text-gray-300">{children}</p>,
  ul: ({ children }) => <ul className="list-disc ml-4 mb-2 space-y-1 text-gray-300">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal ml-4 mb-2 space-y-1 text-gray-300">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed pl-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="text-blue-400 hover:text-blue-300 underline decoration-blue-400/30 underline-offset-2 hover:decoration-blue-300/50 transition-colors">
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      const lang = className?.replace("language-", "") ?? "";
      return (
        <div className="my-2.5 rounded-lg overflow-hidden ring-1 ring-gray-700/30"
          style={{ background: "rgba(2,6,23,0.6)" }}>
          {lang && (
            <div className="flex items-center px-3 py-1 border-b border-gray-800/40">
              <span className="text-[9px] font-mono text-gray-600 uppercase tracking-wider">{lang}</span>
            </div>
          )}
          <pre className="p-3 overflow-x-auto">
            <code className="text-[11px] font-mono leading-5 text-gray-300">{children}</code>
          </pre>
        </div>
      );
    }
    return (
      <code className="px-1.5 py-0.5 rounded text-[11px] font-mono text-blue-300/90"
        style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.1)" }}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-blue-500/30 pl-3 my-2 text-gray-400 italic">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2.5 rounded-lg ring-1 ring-gray-700/30" style={{ background: "rgba(2,6,23,0.4)" }}>
      <table className="min-w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-gray-700/40 px-3 py-1.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider"
      style={{ background: "rgba(15,23,42,0.5)" }}>
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b border-gray-800/30 px-3 py-1.5 text-gray-300">{children}</td>,
  hr: () => <hr className="border-gray-800/50 my-3" />,
  strong: ({ children }) => <strong className="font-semibold text-gray-200">{children}</strong>,
  em: ({ children }) => <em className="text-gray-400">{children}</em>,
};

export default memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="text-sm markdown-content">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
