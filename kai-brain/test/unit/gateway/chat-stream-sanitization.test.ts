import { describe, expect, test } from "vitest";
import { __chatStreamInternals } from "../../../src/gateway/methods/chat.js";

describe("gateway chat stream sanitization", () => {
  test("suppresses split <final> tags from streamed chat deltas", () => {
    const state = __chatStreamInternals.createTagStreamState("hide-thinking");

    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("<final", state)).toBe("");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay(">", state)).toBe("");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("hello", state)).toBe("hello");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("</final>", state)).toBe("");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay(" world", state)).toBe(" world");
  });

  test("hides <think> blocks from chat delta stream", () => {
    const state = __chatStreamInternals.createTagStreamState("hide-thinking");

    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("<think>", state)).toBe("");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("secret", state)).toBe("");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("</think>", state)).toBe("");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("visible", state)).toBe("visible");
  });

  test("strips thinking/final tags but keeps reasoning text for thinking stream", () => {
    const state = __chatStreamInternals.createTagStreamState("strip-tags");

    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("<think>", state)).toBe("");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("reasoning", state)).toBe(
      "reasoning",
    );
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("</think>", state)).toBe("");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("<final>", state)).toBe("");
  });

  test("does not treat comparison operators as tags", () => {
    const state = __chatStreamInternals.createTagStreamState("hide-thinking");
    expect(__chatStreamInternals.stripTaggedStreamChunkForDisplay("2 < 3", state)).toBe("2 < 3");
  });
});
