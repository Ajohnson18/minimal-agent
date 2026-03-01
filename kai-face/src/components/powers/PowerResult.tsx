import MarkdownContent from "../chat/MarkdownContent";

interface TextResult { type: "text"; content: string }
interface ReportResult {
  type: "report";
  title: string;
  summary: string;
  sections: Array<{ heading: string; content: string; severity?: "info" | "warning" | "critical" }>;
  score?: number;
}
interface CodeResult { type: "code"; files: Array<{ path: string; language: string; content: string; diff?: string }> }
interface PRResult { type: "pr"; prs: Array<{ repo: string; number: number; title: string; url: string; status: "open" | "merged" | "closed" }> }
interface ImageResult { type: "image"; images: Array<{ url: string; alt?: string; caption?: string }> }
interface TableResult { type: "table"; title?: string; columns: string[]; rows: string[][] }
interface LinksResult { type: "links"; links: Array<{ url: string; label: string; description?: string }> }
interface MixedResult { type: "mixed"; items: PowerResponse[] }

type PowerResponse =
  | TextResult
  | ReportResult
  | CodeResult
  | PRResult
  | ImageResult
  | TableResult
  | LinksResult
  | MixedResult;

const SEVERITY_COLORS = {
  info: { border: "border-blue-500/20", bg: "bg-blue-500/5", text: "text-blue-400", label: "Info" },
  warning: { border: "border-amber-500/20", bg: "bg-amber-500/5", text: "text-amber-400", label: "Warning" },
  critical: { border: "border-red-500/20", bg: "bg-red-500/5", text: "text-red-400", label: "Critical" },
};

function TextRenderer({ result }: { result: TextResult }) {
  return <MarkdownContent content={result.content} />;
}

function ReportRenderer({ result }: { result: ReportResult }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-white">{result.title}</h2>
        {result.score != null && (
          <div className={`px-3 py-1 rounded-full text-xs font-bold ${
            result.score >= 80 ? "bg-emerald-500/15 text-emerald-400" :
            result.score >= 50 ? "bg-amber-500/15 text-amber-400" :
            "bg-red-500/15 text-red-400"
          }`}>
            {result.score}/100
          </div>
        )}
      </div>
      {result.summary && <p className="text-xs text-gray-400 leading-relaxed">{result.summary}</p>}
      {result.sections.map((section, i) => {
        const sev = section.severity ? SEVERITY_COLORS[section.severity] : null;
        return (
          <div key={i} className={`rounded-lg p-4 ${sev ? `border ${sev.border} ${sev.bg}` : "border border-gray-800/20"}`}>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-xs font-semibold text-gray-200">{section.heading}</h3>
              {sev && <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${sev.text} ${sev.bg}`}>{sev.label}</span>}
            </div>
            <div className="text-xs text-gray-400 leading-relaxed">
              <MarkdownContent content={section.content} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CodeRenderer({ result }: { result: CodeResult }) {
  return (
    <div className="space-y-3">
      {result.files.map((file, i) => (
        <div key={i} className="rounded-lg overflow-hidden ring-1 ring-gray-700/30" style={{ background: "rgba(2,6,23,0.6)" }}>
          {file.path && (
            <div className="flex items-center px-3 py-1.5 border-b border-gray-800/40">
              <span className="text-[10px] font-mono text-gray-500">{file.path}</span>
              <span className="text-[9px] font-mono text-gray-700 ml-auto">{file.language}</span>
            </div>
          )}
          <pre className="p-3 overflow-x-auto">
            <code className="text-[11px] font-mono leading-5 text-gray-300">{file.content}</code>
          </pre>
        </div>
      ))}
    </div>
  );
}

function PRRenderer({ result }: { result: PRResult }) {
  const statusColors = {
    open: "text-emerald-400 bg-emerald-500/10",
    merged: "text-purple-400 bg-purple-500/10",
    closed: "text-red-400 bg-red-500/10",
  };
  return (
    <div className="space-y-2">
      {result.prs.map((pr, i) => (
        <a key={i} href={pr.url} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-3 p-3 rounded-lg border border-gray-800/20 hover:border-gray-700/30 hover:bg-gray-800/20 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-500 shrink-0">
            <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" />
          </svg>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-gray-200 truncate">{pr.title}</p>
            <p className="text-[10px] text-gray-600">{pr.repo} #{pr.number}</p>
          </div>
          <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${statusColors[pr.status]}`}>{pr.status}</span>
        </a>
      ))}
    </div>
  );
}

function ImageRenderer({ result }: { result: ImageResult }) {
  return (
    <div className="space-y-3">
      {result.images.map((img, i) => (
        <div key={i}>
          <img src={img.url} alt={img.alt || ""} className="rounded-lg max-w-full" />
          {img.caption && <p className="text-[10px] text-gray-600 mt-1 text-center">{img.caption}</p>}
        </div>
      ))}
    </div>
  );
}

function TableRenderer({ result }: { result: TableResult }) {
  return (
    <div>
      {result.title && <h3 className="text-xs font-semibold text-gray-300 mb-2">{result.title}</h3>}
      <div className="overflow-x-auto rounded-lg ring-1 ring-gray-700/30" style={{ background: "rgba(2,6,23,0.4)" }}>
        <table className="min-w-full text-xs border-collapse">
          <thead>
            <tr>
              {result.columns.map((col, i) => (
                <th key={i} className="border-b border-gray-700/40 px-3 py-1.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider"
                  style={{ background: "rgba(15,23,42,0.5)" }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="border-b border-gray-800/30 px-3 py-1.5 text-gray-300">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LinksRenderer({ result }: { result: LinksResult }) {
  return (
    <div className="space-y-2">
      {result.links.map((link, i) => (
        <a key={i} href={link.url} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-3 p-3 rounded-lg border border-gray-800/20 hover:border-blue-500/20 hover:bg-blue-500/5 transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400 shrink-0">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-blue-300">{link.label}</p>
            {link.description && <p className="text-[10px] text-gray-600 truncate">{link.description}</p>}
          </div>
        </a>
      ))}
    </div>
  );
}

function isPowerResponse(v: unknown): v is PowerResponse {
  return typeof v === "object" && v !== null && "type" in v && typeof (v as { type: unknown }).type === "string";
}

export default function PowerResult({ result }: { result: unknown }) {
  if (!result || !isPowerResponse(result)) {
    return <p className="text-sm text-gray-600 italic">No result available</p>;
  }

  switch (result.type) {
    case "text": return <TextRenderer result={result} />;
    case "report": return <ReportRenderer result={result} />;
    case "code": return <CodeRenderer result={result} />;
    case "pr": return <PRRenderer result={result} />;
    case "image": return <ImageRenderer result={result} />;
    case "table": return <TableRenderer result={result} />;
    case "links": return <LinksRenderer result={result} />;
    case "mixed":
      return (
        <div className="space-y-4">
          {result.items.map((item, i) => (
            <PowerResult key={i} result={item} />
          ))}
        </div>
      );
    default:
      return <p className="text-sm text-gray-500">Unknown result type</p>;
  }
}
