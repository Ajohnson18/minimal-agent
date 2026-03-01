const STOP_VERB_RE = /\b(stop|cancel|abort|halt|terminate)\b/i;
const NEGATION_RE = /\b(don't|do not|dont|not)\s+(stop|cancel|abort|halt|terminate)\b/i;
const EXPLANATORY_RE =
  /\b(how|why|when|what|should|could|can|where)\b[\s\S]{0,80}\b(stop|cancel|abort|halt|terminate)\b/i;

const DIRECT_STOP_PHRASES = new Set([
  "stop",
  "cancel",
  "abort",
  "halt",
  "stop this",
  "stop this run",
  "stop current run",
  "stop the run",
  "stop now",
  "cancel this",
  "cancel this run",
  "abort this run",
  "abort it",
  "stop it",
  "please stop",
  "please cancel",
  "please abort",
  "kill this run",
  "terminate this run",
  "end this run",
]);

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[!?.;,]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isNaturalLanguageStopIntent(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized) return false;
  if (normalized.startsWith("/")) return false;
  if (NEGATION_RE.test(normalized)) return false;
  if (EXPLANATORY_RE.test(normalized)) return false;

  if (DIRECT_STOP_PHRASES.has(normalized)) {
    return true;
  }

  if (!STOP_VERB_RE.test(normalized)) {
    return false;
  }

  // Broad mode: short imperative phrases with a stop verb are treated as control.
  const tokens = normalized.split(" ").filter(Boolean);
  return tokens.length <= 10;
}
