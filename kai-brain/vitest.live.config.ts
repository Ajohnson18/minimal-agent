import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

const liveTimeout = Number(process.env.AVA_LIVE_TIMEOUT_MS ?? "120000");

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: "live",
      include: ["test/live/**/*.test.ts"],
      setupFiles: [
        "./test/setup/live.setup.ts",
        "./test/setup/base.setup.ts",
      ],
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      testTimeout:
        Number.isFinite(liveTimeout) && liveTimeout > 0
          ? liveTimeout
          : 120_000,
      hookTimeout:
        Number.isFinite(liveTimeout) && liveTimeout > 0
          ? liveTimeout
          : 120_000,
    },
  }),
);
