import { createGatewayServer } from "../../src/gateway/server.js";

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}

async function resolveListeningPort(server: {
  address(): string | { port: number } | null;
  once(event: "listening", cb: () => void): void;
}): Promise<number> {
  const current = server.address();
  if (current && typeof current !== "string") {
    return current.port;
  }

  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });

  const next = server.address();
  if (!next || typeof next === "string") {
    throw new Error("Failed to resolve gateway listening port");
  }
  return next.port;
}

async function main(): Promise<void> {
  const path = process.env.AVA_PROCESS_GATEWAY_PATH || "/ws";
  const port = parsePort(process.env.AVA_PROCESS_GATEWAY_PORT);
  const server = createGatewayServer({
    port,
    path,
  });

  const listeningPort = await resolveListeningPort(server as never);
  process.stdout.write(`PROCESS_GATEWAY_READY:${listeningPort}\n`);

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  process.stderr.write(`PROCESS_GATEWAY_ERROR:${String(error)}\n`);
  process.exit(1);
});
