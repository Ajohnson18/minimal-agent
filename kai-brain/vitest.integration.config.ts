import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

const workers = Number(process.env.AVA_INTEGRATION_WORKERS ?? "1");

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: "integration",
      include: ["test/integration/**/*.test.ts"],
      maxWorkers: Number.isFinite(workers) && workers > 0 ? workers : 1,
      minWorkers: 1,
      fileParallelism: false,
      testTimeout: 45_000,
      hookTimeout: 45_000,
    },
  }),
);
