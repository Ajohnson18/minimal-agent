import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

const workers = Number(process.env.AVA_RELIABILITY_WORKERS ?? "1");
const timeoutMs = Number(process.env.AVA_RELIABILITY_TIMEOUT_MS ?? "120000");

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: "reliability",
      include: ["test/reliability/**/*.test.ts"],
      setupFiles: [
        "./test/setup/base.setup.ts",
        "./test/setup/reliability.setup.ts",
      ],
      fileParallelism: false,
      maxWorkers: Number.isFinite(workers) && workers > 0 ? workers : 1,
      minWorkers: 1,
      testTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
      hookTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
    },
  }),
);
