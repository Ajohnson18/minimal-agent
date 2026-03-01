import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: "deterministic",
      include: [
        "test/unit/**/*.test.ts",
        "test/integration/**/*.test.ts",
        "test/contract/**/*.test.ts",
        "test/process-e2e/**/*.test.ts",
      ],
      setupFiles: [
        "./test/setup/base.setup.ts",
        "./test/setup/e2e.setup.ts",
      ],
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      coverage: {
        enabled: true,
        provider: "v8",
        reportsDirectory: "./coverage",
        reporter: ["text", "lcov", "html"],
        include: [
          "src/agent/sanitize-output.ts",
          "src/agent/context-pruning.ts",
          "src/agent/session-adapter.ts",
          "src/agent/tool-loop-guard.ts",
          "src/agent/task-classifier.ts",
          "src/lib/config-loader.ts",
          "src/lib/exec-security.ts",
          "src/lib/exec-approvals.ts",
          "src/lib/ssrf-guard.ts",
          "src/agent/tools/process-registry.ts",
          "src/lib/slack/mentions.ts",
          "src/lib/slack/threading.ts",
          "src/lib/slack/format.ts",
          "src/middlewares/slack.ts",
        ],
        exclude: [
          "dist/**",
          "src/scripts/**",
          "test/**",
          "**/*.d.ts",
          "**/node_modules/**",
        ],
        thresholds: {
          lines: 85,
          functions: 85,
          branches: 75,
          statements: 85,
        },
      },
    },
  }),
);
