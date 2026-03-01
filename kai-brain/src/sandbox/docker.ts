/**
 * Docker Sandbox
 *
 * Manages Docker containers for safe code execution.
 */
import { execa } from "execa";
import { mkdir, writeFile, readFile, readdir, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const SANDBOX_IMAGE = "ava-sandbox-exec";
const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds
const MAX_MEMORY = "512m";
const MAX_CPU = "1";

export interface SandboxOptions {
  timeoutMs?: number;
  networkEnabled?: boolean;
  workspaceFiles?: Map<string, string>; // filename -> content
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  files: Map<string, string>; // Text output files from workspace
  binaryFilePaths: Map<string, string>; // Binary output files: name -> persistent path
  durationMs: number;
}

/**
 * Check if Docker is available.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execa("docker", ["info"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the sandbox image exists.
 */
export async function isSandboxImageBuilt(): Promise<boolean> {
  try {
    const result = await execa("docker", ["images", "-q", SANDBOX_IMAGE]);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Build the sandbox image.
 */
export async function buildSandboxImage(): Promise<void> {
  console.log("Building sandbox Docker image...");

  try {
    await execa(
      "docker",
      ["build", "-t", SANDBOX_IMAGE, "-f", "Dockerfile.sandbox-exec", "."],
      {
        cwd: process.cwd(),
        stdio: "inherit",
      }
    );
    console.log("Sandbox image built successfully");
  } catch (error) {
    throw new Error(`Failed to build sandbox image: ${error}`);
  }
}

/**
 * Ensure the sandbox image is available.
 */
export async function ensureSandboxImage(): Promise<void> {
  const isBuilt = await isSandboxImageBuilt();
  if (!isBuilt) {
    await buildSandboxImage();
  }
}

/**
 * Run Python code in a sandboxed Docker container.
 */
export async function runInSandbox(
  code: string,
  options: SandboxOptions = {}
): Promise<SandboxResult> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    networkEnabled = false,
    workspaceFiles = new Map(),
  } = options;

  const startTime = Date.now();

  // Create temporary workspace
  // Use project's .sandbox directory which is definitely accessible to Docker
  // (it's under /Users/ which Docker for Mac shares by default)
  const workspaceId = randomUUID();
  const baseTmp = join(process.cwd(), ".sandbox");
  const workspaceDir = join(baseTmp, workspaceId);
  await mkdir(workspaceDir, { recursive: true });

  try {
    // Write input files
    for (const [filename, content] of workspaceFiles) {
      await writeFile(join(workspaceDir, filename), content);
    }

    // Write the Python script
    const scriptPath = join(workspaceDir, "script.py");
    await writeFile(scriptPath, code);

    // Build Docker command
    const dockerArgs = [
      "run",
      "--rm",
      "--user",
      "sandbox",
      "--workdir",
      "/workspace",
      "--memory",
      MAX_MEMORY,
      "--cpus",
      MAX_CPU,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=128m",
      "-v",
      `${workspaceDir}:/workspace:rw`,
    ];

    // Network isolation
    if (!networkEnabled) {
      dockerArgs.push("--network", "none");
    }

    dockerArgs.push(SANDBOX_IMAGE, "python3", "/workspace/script.py");

    // Execute with timeout
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let timedOut = false;

    try {
      const result = await execa("docker", dockerArgs, {
        timeout: timeoutMs,
        reject: false,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode ?? 1;
    } catch (error) {
      // Handle timeout
      if (
        (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
        String(error).includes("timed out")
      ) {
        timedOut = true;
        stderr = "Execution timed out";
        exitCode = 124;
      } else {
        throw error;
      }
    }

    // Collect output files
    const outputFiles = new Map<string, string>();
    const binaryFilePaths = new Map<string, string>();
    const BINARY_EXTENSIONS = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
      ".pdf", ".zip", ".tar", ".gz", ".xlsx", ".xls", ".parquet",
    ]);
    try {
      const files = await readdir(workspaceDir);
      for (const file of files) {
        if (file === "script.py") continue;
        if (workspaceFiles.has(file)) continue; // Skip input files

        const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          // Copy binary file to persistent output dir
          const outputDir = join(process.cwd(), ".sandbox", "python-output", workspaceId);
          await mkdir(outputDir, { recursive: true });
          const destPath = join(outputDir, file);
          await copyFile(join(workspaceDir, file), destPath);
          binaryFilePaths.set(file, destPath);
        } else {
          try {
            const content = await readFile(join(workspaceDir, file), "utf-8");
            outputFiles.set(file, content);
          } catch {
            // Unknown binary — still preserve it
            const outputDir = join(process.cwd(), ".sandbox", "python-output", workspaceId);
            await mkdir(outputDir, { recursive: true });
            const destPath = join(outputDir, file);
            await copyFile(join(workspaceDir, file), destPath);
            binaryFilePaths.set(file, destPath);
          }
        }
      }
    } catch {
      // Ignore errors reading output files
    }

    return {
      stdout,
      stderr,
      exitCode,
      timedOut,
      files: outputFiles,
      binaryFilePaths,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // Cleanup workspace
    try {
      await rm(workspaceDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Validate Python code for obvious issues.
 */
export function validatePythonCode(code: string): {
  valid: boolean;
  error?: string;
} {
  // Check for common issues
  const lines = code.split("\n");

  // Check for empty code
  if (code.trim().length === 0) {
    return { valid: false, error: "Code cannot be empty" };
  }

  // Check for obvious syntax issues
  let openParens = 0;
  let openBrackets = 0;
  let openBraces = 0;

  for (const line of lines) {
    // Skip comments and strings (simplified check)
    const trimmed = line.split("#")[0];
    openParens += (trimmed.match(/\(/g) || []).length;
    openParens -= (trimmed.match(/\)/g) || []).length;
    openBrackets += (trimmed.match(/\[/g) || []).length;
    openBrackets -= (trimmed.match(/\]/g) || []).length;
    openBraces += (trimmed.match(/\{/g) || []).length;
    openBraces -= (trimmed.match(/\}/g) || []).length;
  }

  if (openParens !== 0 || openBrackets !== 0 || openBraces !== 0) {
    return { valid: false, error: "Unbalanced brackets or parentheses" };
  }

  return { valid: true };
}
