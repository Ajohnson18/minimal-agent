import { execa } from "execa";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_IMAGE = "ava-sandbox-exec";
const CONTAINER_PREFIX = "ava-sandbox-";
const CONFIG_HASH_LABEL = "ava.config-hash";
const LAST_USED_LABEL = "ava.last-used";
const PYTHON_CAPABILITY_CHECK_COMMAND =
  "import requests,pandas,numpy,matplotlib; print('sandbox-image-ok')";

export interface SandboxContainerConfig {
  image: string;
  memory: string;
  cpus: string;
  network: "none" | "bridge";
  workdir: string;
  hostWorkspaceDir: string;
  idleTimeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function configHash(cfg: SandboxContainerConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(cfg))
    .digest("hex")
    .slice(0, 16);
}

function containerName(scopeKey: string): string {
  const slug = scopeKey
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
  return `${CONTAINER_PREFIX}${slug}`.slice(0, 63);
}

/**
 * Validate sandbox security.
 * Prevents mounting dangerous host paths like Docker socket
 */
export function validateSandboxVolumeMounts(volumeMounts: string[]): void {
  const BLOCKED_PATHS = [
    "/var/run/docker.sock",
    "/private/var/run/docker.sock", // macOS
    "/run/docker.sock",
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/root",
  ];

  for (const mount of volumeMounts) {
    const hostPath = mount.split(":")[0];
    for (const blocked of BLOCKED_PATHS) {
      if (hostPath.includes(blocked)) {
        throw new Error(
          `Security violation: Cannot mount ${blocked} in sandbox mode.\n` +
            `This would compromise container isolation.\n` +
            `If you need Docker access, run tool on host instead.`,
        );
      }
    }
  }
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execa("docker", ["info"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function verifySandboxImageCapabilities(
  image = DEFAULT_IMAGE,
): Promise<void> {
  await execa("docker", [
    "run",
    "--rm",
    image,
    "python3",
    "-c",
    PYTHON_CAPABILITY_CHECK_COMMAND,
  ], {
    timeout: 60_000,
  });
}

async function isContainerRunning(name: string): Promise<boolean> {
  try {
    const result = await execa("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      name,
    ]);
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function getContainerLabel(
  name: string,
  label: string,
): Promise<string | null> {
  try {
    const result = await execa("docker", [
      "inspect",
      "--format",
      `{{index .Config.Labels "${label}"}}`,
      name,
    ]);
    const val = result.stdout.trim();
    return val && val !== "<no value>" ? val : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a sandbox container exists and is running for the given scope.
 * Reuses existing containers if config hash matches.
 */
export async function ensureContainer(
  scopeKey: string,
  config: SandboxContainerConfig,
): Promise<string> {
  const name = containerName(scopeKey);
  const hash = configHash(config);

  const running = await isContainerRunning(name);
  if (running) {
    const existingHash = await getContainerLabel(name, CONFIG_HASH_LABEL);
    if (existingHash === hash) {
      const lastUsed = await getContainerLabel(name, LAST_USED_LABEL);
      const idleMs = Date.now() - (lastUsed ? parseInt(lastUsed, 10) : 0);
      if (idleMs > (config.idleTimeoutMs ?? 1_800_000)) {
        await destroyContainer(name);
      } else {
        await touchContainer(name);
        return name;
      }
    } else {
      await destroyContainer(name);
    }
  }

  // Remove stopped container with same name
  try {
    await execa("docker", ["rm", "-f", name], { reject: false });
  } catch { /* ignore */ }

  // Ensure host workspace directory exists for bind mount
  mkdirSync(config.hostWorkspaceDir, { recursive: true });
  // Make writable but not world-writable (security hardening)
  chmodSync(config.hostWorkspaceDir, 0o755);

  const createArgs = [
    "create",
    "--name", name,
    "--user", "sandbox",
    "--workdir", config.workdir,
    "--memory", config.memory,
    "--cpus", config.cpus,
    "--read-only",
    "-v", `${config.hostWorkspaceDir}:${config.workdir}:rw`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs", "/var/tmp:rw,noexec,nosuid,size=64m",
    "--label", `${CONFIG_HASH_LABEL}=${hash}`,
    "--label", `${LAST_USED_LABEL}=${Date.now()}`,
    "--network", config.network,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
  ];

  // Mount MCP configs if they exist (read-only for security)
  const home = homedir();
  const mcpConfigs = [
    { host: join(home, ".mcporter"), container: "/home/sandbox/.mcporter" },
    { host: join(home, ".mcp"), container: "/home/sandbox/.mcp" },
    { host: join(process.cwd(), "config", "mcporter.json"), container: "/home/sandbox/.mcporter/config.json" },
  ];

  for (const { host, container } of mcpConfigs) {
    if (existsSync(host)) {
      createArgs.push("-v", `${host}:${container}:ro`);
    }
  }

  createArgs.push(config.image, "sleep", "infinity");

  // Validate security before creating container
  const volumeMounts = createArgs
    .map((arg, i, arr) => (arr[i - 1] === "-v" ? arg : null))
    .filter((x): x is string => x !== null);
  validateSandboxVolumeMounts(volumeMounts);

  await execa("docker", createArgs);
  await execa("docker", ["start", name]);
  return name;
}

async function touchContainer(name: string): Promise<void> {
  try {
    await execa("docker", [
      "container",
      "update",
      "--label-add",
      `${LAST_USED_LABEL}=${Date.now()}`,
      name,
    ], { reject: false });
  } catch { /* label update is best-effort */ }
}

/**
 * Execute a command inside a running sandbox container.
 */
export async function execInContainer(
  name: string,
  command: string,
  env: Record<string, string>,
  workdir?: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  const args = ["exec", "-i"];

  if (workdir) {
    args.push("-w", workdir);
  }

  for (const [key, value] of Object.entries(env)) {
    if (key === "PATH" || key.startsWith("LD_") || key.startsWith("DYLD_")) continue;
    args.push("-e", `${key}=${value}`);
  }

  args.push(name, "sh", "-lc", command);

  try {
    const result = await execa("docker", args, {
      timeout: timeoutMs ?? 300_000,
      reject: false,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
      timedOut: false,
    };
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes("ETIMEDOUT") || errStr.includes("timed out")) {
      return { stdout: "", stderr: "Execution timed out", exitCode: 124, timedOut: true };
    }
    throw err;
  }
}

/**
 * Destroy a sandbox container.
 */
export async function destroyContainer(name: string): Promise<void> {
  try {
    await execa("docker", ["rm", "-f", name], { reject: false });
  } catch { /* ignore */ }
}

/**
 * Prune sandbox containers that have been idle longer than maxIdleMs.
 */
export async function pruneIdleContainers(maxIdleMs: number): Promise<number> {
  let pruned = 0;
  try {
    const result = await execa("docker", [
      "ps",
      "--filter", `name=${CONTAINER_PREFIX}`,
      "--format", "{{.Names}}",
    ]);
    const names = result.stdout
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);

    const now = Date.now();
    for (const name of names) {
      const lastUsed = await getContainerLabel(name, LAST_USED_LABEL);
      const ts = lastUsed ? parseInt(lastUsed, 10) : 0;
      if (now - ts > maxIdleMs) {
        await destroyContainer(name);
        pruned++;
      }
    }
  } catch { /* ignore */ }
  return pruned;
}

/**
 * Check if the sandbox exec image is available.
 */
export async function isSandboxExecImageBuilt(
  image = DEFAULT_IMAGE,
): Promise<boolean> {
  try {
    const result = await execa("docker", ["images", "-q", image]);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
