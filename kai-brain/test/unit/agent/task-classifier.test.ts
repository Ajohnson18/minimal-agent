import { describe, expect, test } from "vitest";

import type { Message } from "@mariozechner/pi-ai";
import { classifyTask } from "../../../src/agent/task-classifier.js";

describe("task-classifier", () => {
  test("classifies vision when explicit image context exists", () => {
    const result = classifyTask("what is this?", {
      hasImages: true,
      messages: [],
    });

    expect(result).toBe("vision");
  });

  test("treats legacy control token text as normal medium task text", () => {
    const result = classifyTask("HEARTBEAT_OK", {
      messages: [],
    });

    expect(result).toBe("medium");
  });

  test("classifies file reads as simple", () => {
    const result = classifyTask("cat src/index.ts", {
      messages: [],
    });

    expect(result).toBe("simple");
  });

  test("classifies architecture requests as complex", () => {
    const result = classifyTask("Design a system architecture for this service", {
      messages: [],
    });

    expect(result).toBe("complex");
  });

  test("defaults to medium for ordinary debugging tasks", () => {
    const result = classifyTask("debug this issue", {
      messages: [] as Message[],
    });

    expect(result).toBe("medium");
  });
});
