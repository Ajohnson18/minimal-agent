/**
 * Tool Input Parsing Utilities
 *
 * Provides consistent error handling and parameter validation across all tools.
 */

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function readStringParam(
  input: unknown,
  key: string,
  opts?: { required?: boolean; default?: string }
): string {
  const value = (input as Record<string, unknown>)?.[key];
  if (value === undefined || value === null) {
    if (opts?.required) {
      throw new ToolInputError(`Missing required parameter: ${key}`);
    }
    return opts?.default ?? "";
  }
  if (typeof value !== "string") {
    throw new ToolInputError(`Parameter ${key} must be a string, got ${typeof value}`);
  }
  return value;
}

export function readNumberParam(
  input: unknown,
  key: string,
  opts?: { required?: boolean; min?: number; max?: number; default?: number }
): number | undefined {
  const value = (input as Record<string, unknown>)?.[key];
  if (value === undefined || value === null) {
    if (opts?.required) {
      throw new ToolInputError(`Missing required parameter: ${key}`);
    }
    return opts?.default;
  }
  const num = Number(value);
  if (isNaN(num)) {
    throw new ToolInputError(`Parameter ${key} must be a number, got ${typeof value}`);
  }
  if (opts?.min !== undefined && num < opts.min) {
    throw new ToolInputError(`Parameter ${key} must be >= ${opts.min}, got ${num}`);
  }
  if (opts?.max !== undefined && num > opts.max) {
    throw new ToolInputError(`Parameter ${key} must be <= ${opts.max}, got ${num}`);
  }
  return num;
}

export function readStringArrayParam(
  input: unknown,
  key: string,
  opts?: { required?: boolean; default?: string[] }
): string[] {
  const value = (input as Record<string, unknown>)?.[key];
  if (value === undefined || value === null) {
    if (opts?.required) {
      throw new ToolInputError(`Missing required parameter: ${key}`);
    }
    return opts?.default ?? [];
  }
  if (!Array.isArray(value)) {
    throw new ToolInputError(`Parameter ${key} must be an array, got ${typeof value}`);
  }
  if (!value.every((item) => typeof item === "string")) {
    throw new ToolInputError(`Parameter ${key} must be an array of strings`);
  }
  return value;
}

export function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}
