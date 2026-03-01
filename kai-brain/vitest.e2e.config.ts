import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

const workers = Number(process.env.AVA_E2E_WORKERS ?? "1");

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      // Backward-compatible alias during suite migration.
      name: "e2e-contract-alias",
      include: ["test/contract/**/*.test.ts"],
      setupFiles: [
        "./test/setup/base.setup.ts",
        "./test/setup/e2e.setup.ts",
      ],
      maxWorkers: Number.isFinite(workers) && workers > 0 ? workers : 1,
      minWorkers: 1,
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);
