import type { Express } from "express";
import type { Server } from "node:http";

export async function startHttpServer(app: Express): Promise<{
  server: Server;
  baseUrl: string;
}> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve listening address"));
        return;
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
    server.once("error", (error) => reject(error));
  });
}

export async function closeHttpServer(server: Server): Promise<void> {
  if (!server || !server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
