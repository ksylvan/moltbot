import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession edge cases — content blocks", () => {
  it("ignores late text_end from a previous content block after boundary reset", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      onAgentEvent,
      blockReplyBreak: "text_end",
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Block 0: stream "Hello"
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello",
        contentIndex: 0,
      },
    });

    // Block 0: text_end with full content
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Hello",
        contentIndex: 0,
      },
    });

    // Block 1: text_start begins new block — triggers boundary reset
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_start",
        delta: "",
        content: "",
        contentIndex: 1,
      },
    });

    // Late text_end from block 0 arrives AFTER the boundary reset
    // This should be ignored entirely, not re-appended
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Hello",
        contentIndex: 0,
      },
    });

    // Block 1: stream " world"
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: " world",
        contentIndex: 1,
      },
    });

    // Block 1: text_end
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: " world",
        contentIndex: 1,
      },
    });

    // The block replies should be "Hello" from block 0 and " world" from block 1.
    // Without the guard, the late text_end would have re-appended "Hello" into block 1.
    const blockTexts = onBlockReply.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(blockTexts).toHaveLength(2);
    expect(blockTexts[0]).toBe("Hello");
    // The delta for block 1 was " world" — block reply preserves it as-is.
    // Crucially, "Hello" must NOT appear in the second block reply.
    expect(blockTexts[1]).not.toContain("Hello");
    expect(blockTexts[1]!.trim()).toBe("world");
  });

  it("handles empty content blocks between tool calls without error", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Block 0: real text
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Before tool",
        contentIndex: 0,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Before tool",
        contentIndex: 0,
      },
    });

    // Block 2: empty content block (block 1 was a tool_use, not text)
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_start",
        delta: "",
        content: "",
        contentIndex: 2,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        delta: "",
        content: "",
        contentIndex: 2,
      },
    });

    // Block 3: real text after tool
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "After tool",
        contentIndex: 3,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "After tool",
        contentIndex: 3,
      },
    });

    const blockTexts = onBlockReply.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    // Should get "Before tool" and "After tool", the empty block should be a no-op
    expect(blockTexts).toContain("Before tool");
    expect(blockTexts).toContain("After tool");
    // The empty block between tool calls should not produce any block reply
    // and should not cause duplication of existing block text.
    const beforeCount = blockTexts.filter((t) => t === "Before tool").length;
    const afterCount = blockTexts.filter((t) => t === "After tool").length;
    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
  });

  it("single-block messages are unaffected by content block boundary logic", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onAgentEvent,
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Single block, contentIndex = 0 (or undefined for some providers)
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello ",
        contentIndex: 0,
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "world!",
        contentIndex: 0,
      },
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world!" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    // Should emit exactly one block reply with full text
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0][0].text).toBe("Hello world!");

    // Agent events should show progressive deltas
    const payloads = onAgentEvent.mock.calls
      .map((call) => call[0]?.data as Record<string, unknown> | undefined)
      .filter((value): value is Record<string, unknown> => Boolean(value));
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads[0]?.text).toBe("Hello");
    expect(payloads[0]?.delta).toBe("Hello");

    expect(subscription.assistantTexts).toEqual(["Hello world!"]);
  });

  it("single-block messages with undefined contentIndex work correctly", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Some providers don't send contentIndex at all
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "No index",
      },
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "No index" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0][0].text).toBe("No index");
    expect(subscription.assistantTexts).toEqual(["No index"]);
  });
});
