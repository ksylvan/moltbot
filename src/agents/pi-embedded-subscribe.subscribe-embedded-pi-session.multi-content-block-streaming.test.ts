import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession — multi-content-block streaming", () => {
  it("emits separate block replies for each content block in a multi-tool response", () => {
    let handler: SessionEventHandler | undefined;
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
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 50, maxChars: 2000 },
    });

    // message_start
    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Block 1 (contentIndex: 0): "Let me gather all three simultaneously."
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_start",
        delta: "",
        content: "",
        contentIndex: 0,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Let me gather all three simultaneously.",
        contentIndex: 0,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Let me gather all three simultaneously.",
        contentIndex: 0,
      },
    });

    // Tool events happen here (tool_execution_start / tool_execution_end)
    // — handled by tool handler, not message handler; we skip directly to block 2.

    // Block 2 (contentIndex: 2): "Here are the results:\n\n1. Git diff..."
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
        type: "text_delta",
        delta: "Here are the results:\n\n1. Git diff shows no changes.",
        contentIndex: 2,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Here are the results:\n\n1. Git diff shows no changes.",
        contentIndex: 2,
      },
    });

    // message_end with full content
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me gather all three simultaneously." },
        { type: "tool_use", id: "tool_1", name: "bash", input: {} },
        { type: "text", text: "Here are the results:\n\n1. Git diff shows no changes." },
      ],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    // Assert: onBlockReply called at least twice
    const blockTexts = onBlockReply.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(blockTexts.length).toBeGreaterThanOrEqual(2);

    // First block reply includes "Let me gather"
    expect(blockTexts[0]).toContain("Let me gather");

    // Second block reply includes "Here are the results"
    const secondAndLater = blockTexts.slice(1).join(" ");
    expect(secondAndLater).toContain("Here are the results");

    // NO block reply should contain the overlapping text pattern
    for (const text of blockTexts) {
      expect(text).not.toContain("Let me gather all three simultaneously.Here are the results");
    }

    // assistantTexts should contain separate entries for each block
    expect(subscription.assistantTexts.length).toBeGreaterThanOrEqual(2);
  });

  it("resets deltaBuffer at content block boundary", () => {
    let handler: SessionEventHandler | undefined;
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
      blockReplyChunking: { minChars: 50, maxChars: 2000 },
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Block 1 deltas accumulating text
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "First block content here.",
        contentIndex: 0,
      },
    });

    // text_start with new contentIndex triggers boundary reset and flushes block 1
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

    // Verify block 1 was flushed
    const block1Texts = onBlockReply.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(block1Texts).toHaveLength(1);
    expect(block1Texts[0]).toBe("First block content here.");

    // Block 2 deltas — should be independent of block 1
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Second block independent.",
        contentIndex: 2,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Second block independent.",
        contentIndex: 2,
      },
    });

    // Verify block 2 is independent
    const allTexts = onBlockReply.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(allTexts).toHaveLength(2);
    expect(allTexts[1]).toBe("Second block independent.");
    // Block 2's reply must NOT contain block 1's text
    expect(allTexts[1]).not.toContain("First block");
  });

  it("handles empty content blocks between tool calls", () => {
    let handler: SessionEventHandler | undefined;
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
      blockReplyChunking: { minChars: 50, maxChars: 2000 },
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Block 0: real text
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Before the tool call.",
        contentIndex: 0,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Before the tool call.",
        contentIndex: 0,
      },
    });

    // Block 2: empty content block (text_start → text_end with no content)
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
        type: "text_start",
        delta: "",
        content: "",
        contentIndex: 3,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "After the tool call.",
        contentIndex: 3,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "After the tool call.",
        contentIndex: 3,
      },
    });

    // No crash — verify correct block replies
    const blockTexts = onBlockReply.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(blockTexts).toContain("Before the tool call.");
    expect(blockTexts).toContain("After the tool call.");
    // No duplicates
    const beforeCount = blockTexts.filter((t) => t === "Before the tool call.").length;
    const afterCount = blockTexts.filter((t) => t === "After the tool call.").length;
    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
  });

  it("ignores late text_end from previous content block", () => {
    let handler: SessionEventHandler | undefined;
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
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 50, maxChars: 2000 },
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Block 1 (contentIndex: 0): "Block one"
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Block one",
        contentIndex: 0,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Block one",
        contentIndex: 0,
      },
    });

    // Block 2 (contentIndex: 2): starts streaming
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
        type: "text_delta",
        delta: "Block two",
        contentIndex: 2,
      },
    });

    // LATE text_end from block 0 arrives after block 2 has started
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Block one",
        contentIndex: 0,
      },
    });

    // Block 2 completes
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Block two",
        contentIndex: 2,
      },
    });

    // message_end
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Block one" },
        { type: "tool_use", id: "tool_1", name: "bash", input: {} },
        { type: "text", text: "Block two" },
      ],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    // assistantTexts should contain separate entries, no "Block oneBlock one" overlap
    expect(subscription.assistantTexts).toContain("Block one");
    expect(subscription.assistantTexts).toContain("Block two");
    // No overlapping concatenation
    const joined = subscription.assistantTexts.join("");
    expect(joined).not.toContain("Block oneBlock one");

    // onBlockReply was called for both blocks
    const blockTexts = onBlockReply.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(blockTexts.length).toBeGreaterThanOrEqual(2);

    // Block 2's reply does NOT contain block 1's text
    const block2Replies = blockTexts.filter((t) => t.includes("Block two"));
    for (const reply of block2Replies) {
      expect(reply).not.toContain("Block one");
    }
  });

  it("single content block messages work unchanged", () => {
    let handler: SessionEventHandler | undefined;
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
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 50, maxChars: 2000 },
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Single block, no contentIndex (simulating providers that don't send it)
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Simple reply",
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
      },
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Simple reply" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Simple reply"]);
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("single content block with contentIndex 0 works unchanged", () => {
    let handler: SessionEventHandler | undefined;
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
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 50, maxChars: 2000 },
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Single block with contentIndex: 0
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_start",
        delta: "",
        content: "",
        contentIndex: 0,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Simple reply",
        contentIndex: 0,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Simple reply",
        contentIndex: 0,
      },
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Simple reply" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: assistantMessage });

    // Boundary detection should NOT trigger for the first and only block
    expect(subscription.assistantTexts).toEqual(["Simple reply"]);
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("emits cumulative text in agent events across content block boundaries", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onAgentEvent,
      blockReplyBreak: "text_end",
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Block 0: "Let me check both in parallel."
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Let me check both in parallel.",
        contentIndex: 0,
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Let me check both in parallel.",
        contentIndex: 0,
      },
    });

    // Tool use block (contentIndex 1) — not a text event, skipped here

    // Block 2: "Here's your calendar:"
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
        type: "text_delta",
        delta: "Here's your calendar:",
        contentIndex: 2,
      },
    });

    // Collect all agent event emissions
    const assistantEvents = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter(
        (evt): evt is { stream: string; data: { text: string; delta: string } } =>
          evt?.stream === "assistant" && typeof evt?.data?.text === "string",
      );

    // The last agent event's text field should contain ALL text from the message,
    // not just the current block's text. This is what the gateway chat layer uses
    // for its buffer and final message.
    const lastEvent = assistantEvents[assistantEvents.length - 1];
    expect(lastEvent.data.text).toContain("Let me check both in parallel.");
    expect(lastEvent.data.text).toContain("Here's your calendar:");

    // The text must be cumulative: block 0 text + "\n" separator + block 2 text
    // (newline matches extractAssistantText's join behavior at message_end)
    expect(lastEvent.data.text).toBe("Let me check both in parallel.\nHere's your calendar:");

    // The delta should be just the new content from block 2
    expect(lastEvent.data.delta).toBe("Here's your calendar:");

    // Earlier events from block 0 should have had per-block text at that point
    const block0Events = assistantEvents.filter((evt) => !evt.data.text.includes("calendar"));
    expect(block0Events.length).toBeGreaterThan(0);
    expect(block0Events[block0Events.length - 1].data.text).toBe("Let me check both in parallel.");
  });
});
