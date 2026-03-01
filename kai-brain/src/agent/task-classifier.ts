/**
 * Task Classifier
 *
 * Classifies incoming tasks by complexity to enable model routing.
 * Routes tasks to appropriate models based on their complexity.
 */
import type { Message } from '@mariozechner/pi-ai';

export type TaskComplexity = 'simple' | 'medium' | 'complex' | 'vision';

export interface ClassificationContext {
  messages: Message[];
  hasImages?: boolean;
}

/**
 * Classify a task based on its content and context.
 *
 * Rules:
 * - simple: file reads/writes (single file), status checks, directory listings
 * - vision: when images are present in context
 * - complex: multi-step reasoning, architecture decisions, code refactors, creative writing
 * - medium: everything else (default)
 */
export function classifyTask(
  message: string,
  context: ClassificationContext
): TaskComplexity {
  const lowerMessage = message.toLowerCase();

  // Vision: images present in context
  if (context.hasImages) {
    return 'vision';
  }

  // Check for images in message content
  if (context.messages.some((m) => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      return m.content.some((c: any) => c.type === 'image');
    }
    return false;
  })) {
    return 'vision';
  }

  // Simple: basic file operations (single file)
  const simpleFileOps = [
    /^read\s+[\w\-\.\/]+$/i,
    /^cat\s+[\w\-\.\/]+$/i,
    /^ls\s*[\w\-\.\/]*$/i,
    /^pwd$/i,
    /^list\s+files/i,
    /^show\s+(me\s+)?(the\s+)?contents\s+of/i,
    /^what'?s?\s+in\s+[\w\-\.\/]+/i,
  ];

  if (simpleFileOps.some((pattern) => pattern.test(message.trim()))) {
    return 'simple';
  }

  // Simple: status checks
  const statusChecks = [
    'status',
    'git status',
    'check status',
    'what\'s the status',
    'current status',
  ];

  if (statusChecks.some((phrase) => lowerMessage === phrase)) {
    return 'simple';
  }

  // Complex: architecture and design decisions
  const complexPatterns = [
    /architect/i,
    /design\s+(a\s+)?.*?\s*(pattern|decision|system|strategy|architecture)/i,
    /refactor/i,
    /restructur/i,
    /implement\s+.*\s+(architecture|system|framework)/i,
    /how\s+should\s+(i|we)\s+(structure|organize|architect)/i,
    /best\s+(practice|approach)\s+for\s+(designing|building)/i,
    /create\s+.*\s+from\s+scratch/i,
    /build\s+.*\s+(system|service|application)/i,
  ];

  if (complexPatterns.some((pattern) => pattern.test(message))) {
    return 'complex';
  }

  // Complex: creative writing requests
  const creativePatterns = [
    /write\s+(a|an)\s+(story|article|essay|blog|post)/i,
    /creative\s+writing/i,
    /compose\s+(a|an)\s+(poem|song|letter)/i,
  ];

  if (creativePatterns.some((pattern) => pattern.test(message))) {
    return 'complex';
  }

  // Complex: multi-step instructions with "and" or numbered steps
  const hasMultipleSteps =
    (message.match(/\band\b/gi) || []).length >= 3 ||
    /\d+\.\s+.*\n.*\d+\./s.test(message) ||
    /first.*then.*finally/i.test(message) ||
    /step\s+\d+/i.test(message);

  if (hasMultipleSteps) {
    return 'complex';
  }

  // Complex: code generation/refactoring indicators
  const complexCodePatterns = [
    /rewrite\s+.*\s+(to|using|with)/i,
    /migrate\s+.*\s+to/i,
    /convert\s+.*\s+to/i,
    /optimize\s+(the\s+)?(entire|whole)/i,
    /implement\s+.*\s+(feature|functionality)/i,
  ];

  if (complexCodePatterns.some((pattern) => pattern.test(message))) {
    return 'complex';
  }

  // Medium: code review, debugging, explanations
  const mediumPatterns = [
    /review\s+(this|the)\s+code/i,
    /debug/i,
    /fix\s+(the|this)\s+(bug|error|issue)/i,
    /explain\s+(how|why|what)/i,
    /what\s+(does|is)\s+.*\s+(do|mean)/i,
    /help\s+me\s+(understand|with)/i,
  ];

  if (mediumPatterns.some((pattern) => pattern.test(message))) {
    return 'medium';
  }

  // Medium: writing/editing operations on multiple files
  if (
    /write.*and.*write/i.test(message) ||
    /edit.*and.*edit/i.test(message) ||
    /create.*files/i.test(message)
  ) {
    return 'medium';
  }

  // Medium: search and analysis tasks
  const searchPatterns = [
    /search\s+for/i,
    /find\s+all/i,
    /grep/i,
    /look\s+for/i,
    /analyze\s+(the|this)/i,
  ];

  if (searchPatterns.some((pattern) => pattern.test(message))) {
    return 'medium';
  }

  // Default to medium for everything else
  return 'medium';
}
