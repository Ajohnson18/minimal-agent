import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: "unit",
      include: ["test/unit/**/*.test.ts"],
    },
  }),
);
