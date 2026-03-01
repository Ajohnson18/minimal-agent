/**
 * Structured Logger (pino)
 *
 * Central logging for AVA. Provides:
 * - Structured JSON output in production
 * - Pretty-printed output in development
 * - Automatic redaction of sensitive fields
 * - Child loggers with bound context per domain
 * - Request-scoped correlation via sessionId
 */
import pino from 'pino';
import { getConfig } from './config-loader.js';

// --- Base Logger ---

const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

export const logger = pino({
  level: getConfig().logging.level,
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      }
    : undefined, // JSON to stdout in production
  redact: {
    paths: [
      '*.token',
      '*.apiKey',
      '*.api_key',
      '*.secretKey',
      '*.secret_key',
      '*.password',
      '*.credentials',
      '*.SLACK_BOT_TOKEN',
      '*.VERTEX_AI_CREDENTIALS',
      '*.EXA_API_KEY',
      '*.OPENAI_API_KEY',
      '*.LANGFUSE_SECRET_KEY',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
  // Add timestamp in ISO format for production
  ...(isProduction ? { timestamp: pino.stdTimeFunctions.isoTime } : {}),
});

// --- Child Logger Factory ---

export type LoggerDomain =
  | 'agent'
  | 'slack'
  | 'cron'
  | 'queue'
  | 'tool'
  | 'subagent'
  | 'subagent-announce'
  | 'memory'
  | 'compaction'
  | 'web'
  | 'browser'
  | 'gateway'
  | 'tracing'
  | 'skills'
  | 'media'
  | 'user-context'
  | 'user-service'
  | 'hooks';

/**
 * Create a child logger with a domain label and optional bound context.
 *
 * Usage:
 *   const log = createLogger('agent', { sessionId, userId });
 *   log.info('Processing message');
 *   log.error({ err }, 'Failed to execute');
 */
export function createLogger(domain: LoggerDomain, context?: Record<string, unknown>) {
  return logger.child({ domain, ...context });
}

// --- Pre-built Domain Loggers ---
// Use these for quick logging without creating a child each time.
// For request-scoped context, use createLogger() instead.

export const agentLogger = createLogger('agent');
export const slackLogger = createLogger('slack');
export const cronLogger = createLogger('cron');
export const queueLogger = createLogger('queue');
export const toolLogger = createLogger('tool');
export const subagentLogger = createLogger('subagent');
export const memoryLogger = createLogger('memory');
export const compactionLogger = createLogger('compaction');
export const webLogger = createLogger('web');
export const gatewayLogger = createLogger('gateway');
export const tracingLogger = createLogger('tracing');
export const skillsLogger = createLogger('skills');
export const mediaLogger = createLogger('media');

// --- Backward Compatibility ---
// During migration, files can import `log` as a drop-in for console.log
// This should only be used temporarily — prefer domain-specific loggers.
export const log = logger;
