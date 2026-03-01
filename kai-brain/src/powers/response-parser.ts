import type {
  PowerResponse,
  PowerResponseText,
  PowerResponseReport,
  PowerResponseCode,
  PowerResponsePR,
  PowerResponseTable,
} from "./types.js";

const GH_PR_RE = /https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/g;
const CODE_BLOCK_RE = /```(\w+)?(?:\s+([^\n]*))?\n([\s\S]*?)```/g;

export function parseResponse(content: string, outputHint?: string): PowerResponse {
  if (!content || !content.trim()) {
    return { type: "text", content: "" };
  }

  if (outputHint === "report") return parseReport(content);
  if (outputHint === "code") return parseCode(content);
  if (outputHint === "pr") return parsePRs(content);
  if (outputHint === "table") return parseTable(content);

  const prs = extractPRs(content);
  if (prs.length > 0) {
    return {
      type: "mixed",
      items: [
        { type: "pr", prs },
        { type: "text", content },
      ],
    };
  }

  return { type: "text", content };
}

function parseReport(content: string): PowerResponseReport {
  const lines = content.split("\n");
  let title = "";
  let summary = "";
  const sections: PowerResponseReport["sections"] = [];
  let currentSection: { heading: string; lines: string[]; severity?: "info" | "warning" | "critical" } | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      if (currentSection) {
        sections.push({ heading: currentSection.heading, content: currentSection.lines.join("\n").trim(), severity: currentSection.severity });
      }
      const heading = headingMatch[1];
      if (!title) {
        title = heading;
        currentSection = null;
        continue;
      }
      const severity = detectSeverity(heading);
      currentSection = { heading, lines: [], severity };
    } else if (currentSection) {
      currentSection.lines.push(line);
    } else if (!title) {
      if (line.trim()) title = line.trim();
    } else if (!summary && line.trim()) {
      summary += line.trim() + " ";
    }
  }
  if (currentSection) {
    sections.push({ heading: currentSection.heading, content: currentSection.lines.join("\n").trim(), severity: currentSection.severity });
  }

  const scoreMatch = content.match(/(?:score|rating|grade)[:\s]*(\d{1,3})(?:\s*\/\s*100)?/i);
  const score = scoreMatch ? Math.min(100, parseInt(scoreMatch[1], 10)) : undefined;

  return { type: "report", title: title || "Report", summary: summary.trim(), sections, score };
}

function parseCode(content: string): PowerResponseCode | PowerResponseText {
  const files: PowerResponseCode["files"] = [];
  let match: RegExpExecArray | null;
  CODE_BLOCK_RE.lastIndex = 0;
  while ((match = CODE_BLOCK_RE.exec(content)) !== null) {
    const language = match[1] || "text";
    const path = match[2]?.trim() || "";
    const code = match[3];
    files.push({ path, language, content: code });
  }
  if (files.length === 0) return { type: "text", content };
  return { type: "code", files };
}

function parsePRs(content: string): PowerResponsePR | PowerResponseText {
  const prs = extractPRs(content);
  if (prs.length === 0) return { type: "text", content };
  return { type: "pr", prs };
}

function extractPRs(content: string): PowerResponsePR["prs"] {
  const prs: PowerResponsePR["prs"] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  GH_PR_RE.lastIndex = 0;
  while ((match = GH_PR_RE.exec(content)) !== null) {
    const key = `${match[1]}#${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prs.push({
      repo: match[1],
      number: parseInt(match[2], 10),
      title: `PR #${match[2]}`,
      url: match[0],
      status: "open",
    });
  }
  return prs;
}

function parseTable(content: string): PowerResponseTable | PowerResponseText {
  const lines = content.split("\n").filter((l) => l.includes("|"));
  if (lines.length < 2) return { type: "text", content };

  const parseRow = (line: string) =>
    line.split("|").map((c) => c.trim()).filter(Boolean);

  const columns = parseRow(lines[0]);
  const isSeparator = (line: string) => /^[\s|:-]+$/.test(line);
  const dataStart = isSeparator(lines[1]) ? 2 : 1;
  const rows = lines.slice(dataStart).map(parseRow);

  if (columns.length === 0 || rows.length === 0) return { type: "text", content };
  return { type: "table", columns, rows };
}

function detectSeverity(heading: string): "info" | "warning" | "critical" | undefined {
  const lower = heading.toLowerCase();
  if (lower.includes("critical") || lower.includes("error") || lower.includes("high")) return "critical";
  if (lower.includes("warning") || lower.includes("medium") || lower.includes("moderate")) return "warning";
  if (lower.includes("info") || lower.includes("low") || lower.includes("note")) return "info";
  return undefined;
}
