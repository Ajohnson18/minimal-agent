/**
 * Tracing Service (Langfuse)
 *
 * LLM observability for AVA. Captures:
 * - Agent runs as traces (sessionId, userId, model, input/output)
 * - LLM calls as generations (model, prompt, completion, tokens, cost)
 * - Tool calls as spans (name, input, output, duration, status)
 * - Subagent runs as child traces (linked to parent)
 * - Compaction as spans (reason, tokens before/after)
 *
 * Gracefully disabled when LANGFUSE_PUBLIC_KEY is not set or langfuse package is not installed.
 */
import { createLogger } from '../lib/logger.js';

const log = createLogger('tracing');

// --- Langfuse import (optional dependency handling) ---
let Langfuse: any = null;
try {
  const langfuseModule = await import('langfuse');
  Langfuse = langfuseModule.Langfuse;
} catch (error) {
  log.debug({ err: error }, 'Langfuse package not available. Tracing will be disabled.');
}

// --- Model cost config (per 1M tokens) ---
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-20250115': { input: 15, output: 75 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-sonnet-4-5-20250514': { input: 3, output: 15 },
  'claude-haiku-3-5-20241022': { input: 0.80, output: 4 },
  'gemini-2.0-flash': { input: 0.075, output: 0.30 },
  'gemini-2.5-flash-preview-05-20': { input: 0.15, output: 0.60 },
  'gemini-2.5-pro-preview-05-06': { input: 1.25, output: 10 },
};

function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number | undefined {
  const costs = MODEL_COSTS[modelId];
  if (!costs) return undefined;
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

// --- Langfuse Client (lazy init) ---

let langfuseInstance: any = null;
let langfuseEnabled = false;

function getLangfuse() {
  if (langfuseInstance) return langfuseInstance;

  if (!Langfuse) {
    langfuseEnabled = false;
    return null;
  }

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) {
    log.info('Langfuse not configured (LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY missing). Tracing disabled.');
    langfuseEnabled = false;
    return null;
  }

  try {
    langfuseInstance = new Langfuse({
      publicKey,
      secretKey,
      baseUrl,
      flushAt: 5,
      flushInterval: 5000,
    });

    langfuseEnabled = true;
    log.info({ baseUrl }, 'Langfuse tracing initialized');

    // Graceful shutdown
    const shutdown = () => {
      if (langfuseInstance) {
        langfuseInstance.shutdownAsync?.().catch(() => {});
      }
    };
    process.on('beforeExit', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return langfuseInstance;
  } catch (error) {
    log.warn({ err: error }, 'Failed to initialize Langfuse. Tracing disabled.');
    langfuseEnabled = false;
    return null;
  }
}

// --- Trace Handle Types ---

export interface TraceHandle {
  traceId: string;
  /** Add an LLM generation to this trace */
  generation(params: GenerationParams): GenerationHandle;
  /** Add a span (tool call, etc.) to this trace */
  span(params: SpanParams): SpanHandle;
  /** Add an event (log, error, etc.) */
  event(params: EventParams): void;
  /** Update trace metadata (output, status) */
  update(params: TraceUpdateParams): void;
}

export interface GenerationHandle {
  /** End the generation with output and usage */
  end(params: GenerationEndParams): void;
}

export interface SpanHandle {
  /** End the span with output and status */
  end(params: SpanEndParams): void;
}

export interface GenerationParams {
  name: string;
  model: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface GenerationEndParams {
  output?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  statusMessage?: string;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
}

export interface SpanParams {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SpanEndParams {
  output?: unknown;
  statusMessage?: string;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
}

export interface EventParams {
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
}

export interface TraceUpdateParams {
  output?: unknown;
  metadata?: Record<string, unknown>;
  statusMessage?: string;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
}

// --- No-op Handles (when tracing is disabled) ---

const noopGeneration: GenerationHandle = {
  end: () => {},
};

const noopSpan: SpanHandle = {
  end: () => {},
};

const noopTrace: TraceHandle = {
  traceId: '',
  generation: () => noopGeneration,
  span: () => noopSpan,
  event: () => {},
  update: () => {},
};

// --- Public API ---

/**
 * Start a new trace for an agent run.
 */
export function startTrace(params: {
  name: string;
  sessionId: string;
  userId: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  parentTraceId?: string;
}): TraceHandle {
  const lf = getLangfuse();
  if (!lf) return noopTrace;

  try {
    const trace = lf.trace({
      name: params.name,
      sessionId: params.sessionId,
      userId: params.userId,
      input: params.input,
      metadata: {
        ...params.metadata,
        parentTraceId: params.parentTraceId,
      },
    });

    const traceId = trace.id;

    return {
      traceId,

      generation(genParams: GenerationParams): GenerationHandle {
        try {
          const gen = trace.generation({
            name: genParams.name,
            model: genParams.model,
            input: genParams.input,
            metadata: genParams.metadata,
          });

          return {
            end(endParams: GenerationEndParams) {
              try {
                const modelCost =
                  endParams.usage?.inputTokens && endParams.usage?.outputTokens
                    ? calculateCost(
                        genParams.model,
                        endParams.usage.inputTokens,
                        endParams.usage.outputTokens
                      )
                    : undefined;

                gen.end({
                  output: endParams.output,
                  usage: endParams.usage
                    ? {
                        input: endParams.usage.inputTokens,
                        output: endParams.usage.outputTokens,
                        total: endParams.usage.totalTokens,
                        unit: 'TOKENS' as any,
                      }
                    : undefined,
                  calculatedTotalCost: modelCost,
                  statusMessage: endParams.statusMessage,
                  level: endParams.level,
                });
              } catch (e) {
                log.debug({ err: e }, 'Failed to end generation');
              }
            },
          };
        } catch (e) {
          log.debug({ err: e }, 'Failed to create generation');
          return noopGeneration;
        }
      },

      span(spanParams: SpanParams): SpanHandle {
        try {
          const span = trace.span({
            name: spanParams.name,
            input: spanParams.input,
            metadata: spanParams.metadata,
          });

          return {
            end(endParams: SpanEndParams) {
              try {
                span.end({
                  output: endParams.output,
                  statusMessage: endParams.statusMessage,
                  level: endParams.level,
                });
              } catch (e) {
                log.debug({ err: e }, 'Failed to end span');
              }
            },
          };
        } catch (e) {
          log.debug({ err: e }, 'Failed to create span');
          return noopSpan;
        }
      },

      event(eventParams: EventParams) {
        try {
          trace.event({
            name: eventParams.name,
            input: eventParams.input,
            output: eventParams.output,
            metadata: eventParams.metadata,
            level: eventParams.level,
          });
        } catch (e) {
          log.debug({ err: e }, 'Failed to create event');
        }
      },

      update(updateParams: TraceUpdateParams) {
        try {
          trace.update({
            output: updateParams.output,
            metadata: updateParams.metadata,
            statusMessage: updateParams.statusMessage,
            level: updateParams.level,
          });
        } catch (e) {
          log.debug({ err: e }, 'Failed to update trace');
        }
      },
    };
  } catch (e) {
    log.warn({ err: e }, 'Failed to start trace');
    return noopTrace;
  }
}

/**
 * Check if tracing is enabled and configured.
 */
export function isTracingEnabled(): boolean {
  getLangfuse(); // lazy init
  return langfuseEnabled;
}

/**
 * Flush pending traces (call on shutdown).
 */
export async function flushTraces(): Promise<void> {
  if (langfuseInstance) {
    try {
      await langfuseInstance.flushAsync();
    } catch (e) {
      log.debug({ err: e }, 'Failed to flush traces');
    }
  }
}
