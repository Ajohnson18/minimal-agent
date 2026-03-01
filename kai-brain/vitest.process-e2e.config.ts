import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

const workers = Number(process.env.AVA_PROCESS_E2E_WORKERS ?? "1");
const timeoutMs = Number(process.env.AVA_PROCESS_E2E_TIMEOUT_MS ?? "90000");

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: "process-e2e",
      include: ["test/process-e2e/**/*.test.ts"],
      setupFiles: [
        "./test/setup/base.setup.ts",
        "./test/setup/e2e.setup.ts",
      ],
      maxWorkers: Number.isFinite(workers) && workers > 0 ? workers : 1,
      minWorkers: 1,
      fileParallelism: false,
      testTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90_000,
      hookTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90_000,
    },
  }),
);
