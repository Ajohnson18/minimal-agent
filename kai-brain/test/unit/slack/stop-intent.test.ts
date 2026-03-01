import { describe, expect, test } from "vitest";

import { isNaturalLanguageStopIntent } from "../../../src/slack/monitor/stop-intent.js";

describe("slack stop intent detector", () => {
  test("matches broad imperative stop phrases", () => {
    expect(isNaturalLanguageStopIntent("stop")).toBe(true);
    expect(isNaturalLanguageStopIntent("please stop this run")).toBe(true);
    expect(isNaturalLanguageStopIntent("cancel current run now")).toBe(true);
    expect(isNaturalLanguageStopIntent("abort it")).toBe(true);
  });

  test("ignores explanatory or negated statements", () => {
    expect(isNaturalLanguageStopIntent("how do I stop this run?")).toBe(false);
    expect(isNaturalLanguageStopIntent("don't stop this run")).toBe(false);
    expect(isNaturalLanguageStopIntent("/stop")).toBe(false);
  });
});
