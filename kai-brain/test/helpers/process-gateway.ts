import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ProcessGatewayInstance {
  port: number;
  path: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

export async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Failed to allocate ephemeral port");
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export async function spawnGatewayProcess(opts?: {
  path?: string;
  port?: number;
  startupTimeoutMs?: number;
  env?: Record<string, string>;
}): Promise<ProcessGatewayInstance> {
  const path = opts?.path ?? "/ws";
  const port = opts?.port ?? (await getFreePort());
  const startupTimeoutMs = opts?.startupTimeoutMs ?? 20_000;
  const stdout: string[] = [];
  const stderr: string[] = [];

  const child = spawn(
    "pnpm",
    ["exec", "tsx", "test/helpers/process-gateway-entry.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AVA_PROCESS_GATEWAY_PORT: String(port),
        AVA_PROCESS_GATEWAY_PATH: path,
        ...(opts?.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for process gateway startup.\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`,
        ),
      );
    }, startupTimeoutMs);

    const onStdout = (chunk: string) => {
      if (!chunk.includes("PROCESS_GATEWAY_READY:")) {
        return;
      }
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      resolve();
    };

    child.stdout.on("data", onStdout);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Gateway process exited early (code=${String(code)}, signal=${String(signal)}).\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`,
        ),
      );
    });
  });

  return {
    port,
    path,
    child,
    stdout,
    stderr,
  };
}

export async function stopGatewayProcess(
  instance: ProcessGatewayInstance,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 2_500;
  if (instance.child.exitCode !== null) {
    return;
  }

  instance.child.kill("SIGTERM");

  const graceful = await Promise.race([
    new Promise<boolean>((resolve) => {
      instance.child.once("exit", () => resolve(true));
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);

  if (!graceful && instance.child.exitCode === null) {
    instance.child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      instance.child.once("exit", () => resolve());
    });
  }
}
