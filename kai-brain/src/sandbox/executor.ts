/**
 * Sandbox Executor
 *
 * High-level interface for running code in the sandbox.
 */
import {
  runInSandbox,
  validatePythonCode,
  ensureSandboxImage,
  isDockerAvailable,
  type SandboxOptions,
  type SandboxResult,
} from "./docker.js";

export interface PythonExecOptions {
  timeoutMs?: number;
  files?: Record<string, string>; // Input files
}

export interface PythonExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  outputFiles: Record<string, string>;
  binaryFilePaths: Record<string, string>; // name -> persistent path on disk
  durationMs: number;
  error?: string;
}

// Cache Docker availability check
let dockerAvailable: boolean | null = null;
let sandboxReady = false;

/**
 * Check if sandbox execution is available.
 */
export async function isSandboxReady(): Promise<boolean> {
  if (dockerAvailable === null) {
    dockerAvailable = await isDockerAvailable();
  }
  return dockerAvailable;
}

/**
 * Initialize the sandbox (build image if needed).
 */
export async function initializeSandbox(): Promise<void> {
  if (sandboxReady) return;

  const available = await isSandboxReady();
  if (!available) {
    console.warn("Docker not available - sandbox execution disabled");
    return;
  }

  try {
    await ensureSandboxImage();
    sandboxReady = true;
    console.log("Sandbox initialized");
  } catch (error) {
    console.error("Failed to initialize sandbox:", error);
  }
}

/**
 * Execute Python code in the sandbox.
 */
export async function executePython(
  code: string,
  options: PythonExecOptions = {}
): Promise<PythonExecResult> {
  // Check if sandbox is available
  if (!sandboxReady) {
    await initializeSandbox();
  }

  if (!sandboxReady) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      exitCode: 1,
      timedOut: false,
      outputFiles: {},
      binaryFilePaths: {},
      durationMs: 0,
      error:
        "Docker sandbox not available. Make sure Docker is installed and running.",
    };
  }

  // Validate code
  const validation = validatePythonCode(code);
  if (!validation.valid) {
    return {
      success: false,
      stdout: "",
      stderr: validation.error || "Invalid code",
      exitCode: 1,
      timedOut: false,
      outputFiles: {},
      binaryFilePaths: {},
      durationMs: 0,
      error: validation.error,
    };
  }

  // Convert files
  const workspaceFiles = new Map<string, string>();
  if (options.files) {
    for (const [name, content] of Object.entries(options.files)) {
      workspaceFiles.set(name, content);
    }
  }

  // Execute
  try {
    const sandboxOptions: SandboxOptions = {
      timeoutMs: options.timeoutMs,
      workspaceFiles,
      networkEnabled: true, // Allow network for data fetching (yfinance, APIs, etc.)
    };

    const result: SandboxResult = await runInSandbox(code, sandboxOptions);

    // Convert output files
    const outputFiles: Record<string, string> = {};
    for (const [name, content] of result.files) {
      outputFiles[name] = content;
    }

    const binaryFilePaths: Record<string, string> = {};
    for (const [name, path] of result.binaryFilePaths) {
      binaryFilePaths[name] = path;
    }

    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputFiles,
      binaryFilePaths,
      durationMs: result.durationMs,
    };
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      timedOut: false,
      outputFiles: {},
      binaryFilePaths: {},
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Format execution result for agent consumption.
 */
export function formatPythonResult(result: PythonExecResult): string {
  const parts: string[] = [];

  if (result.error) {
    parts.push(`Error: ${result.error}`);
    return parts.join("\n");
  }

  if (result.timedOut) {
    parts.push("Execution timed out (exceeded time limit)");
  }

  if (result.stdout) {
    parts.push("Output:");
    parts.push("```");
    parts.push(result.stdout.slice(0, 50000)); // Limit output size
    parts.push("```");
  }

  if (result.stderr && result.exitCode !== 0) {
    parts.push("Errors:");
    parts.push("```");
    parts.push(result.stderr.slice(0, 10000));
    parts.push("```");
  }

  const fileNames = Object.keys(result.outputFiles);
  if (fileNames.length > 0) {
    parts.push(`\nGenerated text files: ${fileNames.join(", ")}`);

    // Include small text files inline
    for (const [name, content] of Object.entries(result.outputFiles)) {
      if (content.length < 5000) {
        parts.push(`\n### ${name}`);
        parts.push("```");
        parts.push(content);
        parts.push("```");
      }
    }
  }

  const binaryNames = Object.keys(result.binaryFilePaths);
  if (binaryNames.length > 0) {
    parts.push(`\nGenerated binary files (use slack_message with file_path to share):`);
    for (const [name, path] of Object.entries(result.binaryFilePaths)) {
      parts.push(`  - ${name}: ${path}`);
    }
  }

  parts.push(`\nExecution time: ${result.durationMs}ms`);
  parts.push(`Exit code: ${result.exitCode}`);

  return parts.join("\n");
}
