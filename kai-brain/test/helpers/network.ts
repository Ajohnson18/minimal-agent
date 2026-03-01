import { createServer } from "node:net";

export async function canBindLocalPort(): Promise<boolean> {
  const failOnSkip = process.env.AVA_FAIL_ON_SKIP === "1";

  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", (error) => {
      if (failOnSkip) {
        reject(new Error(`Network prerequisite failed: ${String(error)}`));
        return;
      }
      resolve(false);
    });

    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
