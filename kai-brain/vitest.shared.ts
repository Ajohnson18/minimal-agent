import type { UserConfig } from "vitest/config";

const reporters = process.env.CI ? ["default", "junit"] : ["default"];
const outputFile = process.env.CI
  ? { junit: "./reports/vitest-junit.xml" }
  : undefined;

export const sharedTestConfig: UserConfig = {
  test: {
    environment: "node",
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./test/setup/base.setup.ts"],
    reporters,
    outputFile,
  },
};
