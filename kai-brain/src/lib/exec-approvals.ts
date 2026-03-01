import { existsSync, statSync } from "node:fs";
import path from "node:path";

export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";

export interface ExecAllowlistEntry {
  pattern: string;
}

export interface ExecCommandResolution {
  executableName: string;
  resolvedPath: string | null;
}

export interface ExecCommandSegment {
  raw: string;
  argv: string[];
  resolution: ExecCommandResolution;
}

export type ExecSegmentSatisfiedBy = "allowlist" | "safeBins" | null;

export interface ExecAllowlistAnalysis {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segments: ExecCommandSegment[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
}

const SECURITY_RANK: Record<ExecSecurity, number> = {
  deny: 0,
  allowlist: 1,
  full: 2,
};

const ASK_RANK: Record<ExecAsk, number> = {
  off: 0,
  "on-miss": 1,
  always: 2,
};

const DEFAULT_SAFE_BINS: string[] = [];

export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  return SECURITY_RANK[a] <= SECURITY_RANK[b] ? a : b;
}

export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  return ASK_RANK[a] >= ASK_RANK[b] ? a : b;
}

export function normalizeSafeBins(entries?: string[] | null): Set<string> {
  if (!Array.isArray(entries)) {
    return new Set<string>();
  }
  return new Set(
    entries
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

export function resolveSafeBins(entries?: string[] | null): Set<string> {
  if (entries === undefined) {
    return normalizeSafeBins(DEFAULT_SAFE_BINS);
  }
  return normalizeSafeBins(entries);
}

function splitCommandChain(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = i + 1 < command.length ? command[i + 1] : "";

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escape = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === ";") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function tokenizeSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
  }

  if (quote || escape) {
    return null;
  }

  pushCurrent();
  return tokens;
}

function isExecutableFile(candidate: string): boolean {
  if (!existsSync(candidate)) {
    return false;
  }
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveExecutablePath(params: {
  executable: string;
  cwd: string;
  envPath?: string;
}): ExecCommandResolution {
  const executable = params.executable;
  const executableName = path.basename(executable).toLowerCase();

  if (executable.includes("/")) {
    const resolvedPath = path.isAbsolute(executable)
      ? path.normalize(executable)
      : path.resolve(params.cwd, executable);
    return {
      executableName,
      resolvedPath,
    };
  }

  const pathValue = params.envPath ?? process.env.PATH ?? "";
  const pathParts = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const candidateDir of pathParts) {
    const direct = path.join(candidateDir, executable);
    if (isExecutableFile(direct)) {
      return {
        executableName,
        resolvedPath: direct,
      };
    }

    if (process.platform === "win32") {
      const extCandidates = [".exe", ".cmd", ".bat", ".ps1"];
      for (const ext of extCandidates) {
        const winCandidate = `${direct}${ext}`;
        if (isExecutableFile(winCandidate)) {
          return {
            executableName,
            resolvedPath: winCandidate,
          };
        }
      }
    }
  }

  return {
    executableName,
    resolvedPath: null,
  };
}

function analyzeShellCommand(params: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}): { ok: boolean; segments: ExecCommandSegment[] } {
  const cwd = params.cwd || process.cwd();
  const chainSegments = splitCommandChain(params.command);
  if (chainSegments.length === 0) {
    return { ok: false, segments: [] };
  }

  const segments: ExecCommandSegment[] = [];

  for (const rawSegment of chainSegments) {
    const argv = tokenizeSegment(rawSegment);
    if (!argv || argv.length === 0) {
      return { ok: false, segments: [] };
    }

    const resolution = resolveExecutablePath({
      executable: argv[0],
      cwd,
      envPath: params.env?.PATH,
    });

    segments.push({
      raw: rawSegment,
      argv,
      resolution,
    });
  }

  return { ok: true, segments };
}

function escapeRegex(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = escapeRegex(pattern).replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAllowlistPattern(params: {
  pattern: string;
  segment: ExecCommandSegment;
}): boolean {
  const pattern = params.pattern.trim();
  if (!pattern) {
    return false;
  }

  if (pattern === "*") {
    return true;
  }

  const normalizedCommand = params.segment.raw.trim();
  const executableName = params.segment.resolution.executableName;
  const resolvedPath = params.segment.resolution.resolvedPath;

  if (pattern.endsWith(" *")) {
    const prefix = pattern.slice(0, -2);
    return (
      normalizedCommand === prefix ||
      normalizedCommand.startsWith(`${prefix} `) ||
      executableName === prefix ||
      resolvedPath === prefix
    );
  }

  if (pattern.includes("*")) {
    const regex = wildcardToRegex(pattern);
    return (
      regex.test(normalizedCommand) ||
      regex.test(executableName) ||
      (resolvedPath ? regex.test(resolvedPath) : false)
    );
  }

  if (resolvedPath && resolvedPath === pattern) {
    return true;
  }

  if (executableName === pattern.toLowerCase()) {
    return true;
  }

  return normalizedCommand === pattern;
}

export function evaluateShellAllowlist(params: {
  command: string;
  allowlist: string[];
  safeBins?: Set<string>;
  cwd?: string;
  env?: Record<string, string>;
}): ExecAllowlistAnalysis {
  const analysis = analyzeShellCommand({
    command: params.command,
    cwd: params.cwd,
    env: params.env,
  });

  if (!analysis.ok) {
    return {
      analysisOk: false,
      allowlistSatisfied: false,
      allowlistMatches: [],
      segments: [],
      segmentSatisfiedBy: [],
    };
  }

  const allowlistEntries = params.allowlist.map((pattern) => ({ pattern }));
  const safeBins = params.safeBins ?? new Set<string>();

  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];

  for (const segment of analysis.segments) {
    const matched = allowlistEntries.find((entry) =>
      matchesAllowlistPattern({ pattern: entry.pattern, segment }),
    );

    if (matched) {
      allowlistMatches.push(matched);
      segmentSatisfiedBy.push("allowlist");
      continue;
    }

    if (safeBins.has(segment.resolution.executableName)) {
      segmentSatisfiedBy.push("safeBins");
      continue;
    }

    segmentSatisfiedBy.push(null);
  }

  const allowlistSatisfied = segmentSatisfiedBy.every((state) => state !== null);

  return {
    analysisOk: true,
    allowlistSatisfied,
    allowlistMatches,
    segments: analysis.segments,
    segmentSatisfiedBy,
  };
}

/**
 * Evaluate whether a command matches any pattern in the allowlist.
 * Returns enriched analysis for parity with approval flow policy checks.
 */
export function evaluateExecAllowlist(
  command: string,
  allowlist: string[],
): { allowed: boolean; matchedRule?: string } {
  const result = evaluateShellAllowlist({
    command,
    allowlist,
  });

  if (!result.allowlistSatisfied) {
    return { allowed: false };
  }

  return {
    allowed: true,
    matchedRule: result.allowlistMatches[0]?.pattern,
  };
}

/**
 * Check if a command is allowed to execute given the security mode and allowlist.
 */
export function isCommandAllowed(
  command: string,
  security: ExecSecurity,
  allowlist: string[],
): { allowed: boolean; reason?: string } {
  if (security === "full") {
    return { allowed: true };
  }

  if (security === "deny") {
    return { allowed: false, reason: "Exec is disabled (security=deny)." };
  }

  const result = evaluateExecAllowlist(command, allowlist);
  if (result.allowed) {
    return { allowed: true };
  }

  const firstWord = command.trim().split(/\s+/)[0];
  return {
    allowed: false,
    reason: `Command "${firstWord}" is not in the exec allowlist. Allowed: ${allowlist.join(", ") || "(none)"}`,
  };
}

export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
}): boolean {
  return (
    params.ask === "always" ||
    (params.ask === "on-miss" &&
      params.security === "allowlist" &&
      (!params.analysisOk || !params.allowlistSatisfied))
  );
}

export function resolveAllowAlwaysPatterns(params: {
  command: string;
  cwd?: string;
  resolvedPath?: string | null;
}): string[] {
  const analysis = analyzeShellCommand({
    command: params.command,
    cwd: params.cwd,
  });

  const patterns = new Set<string>();

  if (analysis.ok && analysis.segments.length > 0) {
    for (const segment of analysis.segments) {
      const basePattern = segment.resolution.resolvedPath ?? segment.resolution.executableName;
      if (!basePattern) {
        continue;
      }
      const pattern = segment.argv.length > 1 ? `${basePattern} *` : basePattern;
      patterns.add(pattern);
    }
  }

  if (patterns.size === 0 && params.resolvedPath?.trim()) {
    patterns.add(params.resolvedPath.trim());
  }

  if (patterns.size === 0) {
    const firstWord = params.command.trim().split(/\s+/)[0];
    if (firstWord) {
      patterns.add(`${firstWord} *`);
    }
  }

  return Array.from(patterns);
}
