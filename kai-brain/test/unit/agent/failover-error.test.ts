import { describe, expect, test } from "vitest";

import { classifyFailoverError } from "../../../src/agent/failover-error.js";

describe("failover error classifier", () => {
  test("classifies abort/cancel/auth as non-retryable", () => {
    expect(classifyFailoverError("AbortError: signal is aborted")).toMatchObject({
      class: "abort",
      retryable: false,
    });
    expect(classifyFailoverError("request canceled by user")).toMatchObject({
      class: "cancel",
      retryable: false,
    });
    expect(classifyFailoverError("401 unauthorized invalid api key")).toMatchObject({
      class: "auth",
      retryable: false,
    });
  });

  test("classifies rate/model/provider failures as retryable", () => {
    expect(classifyFailoverError("429 rate limit exceeded")).toMatchObject({
      class: "rate_limit",
      retryable: true,
    });
    expect(classifyFailoverError("Model is deprecated and no longer available")).toMatchObject({
      class: "model_deprecated",
      retryable: true,
    });
    expect(classifyFailoverError("unsupported model requested")).toMatchObject({
      class: "model_unsupported",
      retryable: true,
    });
    expect(classifyFailoverError("503 service unavailable timeout")).toMatchObject({
      class: "provider_transient",
      retryable: true,
    });
  });
});
