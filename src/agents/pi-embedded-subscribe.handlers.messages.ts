import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  extractThinkingFromTaggedStream,
  extractThinkingFromTaggedText,
  formatReasoningMessage,
  promoteThinkingTagsToBlocks,
} from "./pi-embedded-utils.js";

const stripTrailingDirective = (text: string): string => {
  const openIndex = text.lastIndexOf("[[");
  if (openIndex < 0) {
    return text;
  }
  const closeIndex = text.indexOf("]]", openIndex + 2);
  if (closeIndex >= 0) {
    return text;
  }
  return text.slice(0, openIndex);
};

export function handleMessageStart(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
) {
  const msg = evt.message;
  // [DIAG-MSG-START] Log ALL message_start events for debugging separator issue
  appendRawStream({
    ts: Date.now(),
    event: "diag_message_start",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    role: msg?.role,
    cumulativeLength: ctx.state.cumulativeStreamedText.length,
    assistantTextsCount: ctx.state.assistantTexts.length,
  });
  if (msg?.role !== "assistant") {
    return;
  }

  // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
  // ASSUME: `message_start` is the only reliable boundary for "new assistant message begins".
  // Start-of-message is a safer reset point than message_end: some providers
  // may deliver late text_end updates after message_end, which would otherwise
  // re-trigger block replies.
  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
  // Use assistant message_start as the earliest "writing" signal for typing.
  void ctx.params.onAssistantMessageStart?.();
}

export function handleMessageUpdate(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant") {
    return;
  }

  const assistantEvent = evt.assistantMessageEvent;
  const assistantRecord =
    assistantEvent && typeof assistantEvent === "object"
      ? (assistantEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";

  // [DIAG3] Log ALL streaming event types (thinking, toolcall, etc.) to diagnose missing thinking blocks.
  if (evtType && evtType !== "text_delta" && evtType !== "text_start" && evtType !== "text_end") {
    const contentIndex =
      typeof assistantRecord?.contentIndex === "number" ? assistantRecord.contentIndex : -1;
    appendRawStream({
      ts: Date.now(),
      event: "diag3_non_text_stream_event",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      evtType,
      contentIndex,
    });
    // Also count content blocks on the partial message for thinking diagnostics.
    if (evtType === "thinking_end" || evtType === "thinking_start") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const thinkingBlocks = content.filter(
        (b) => b && typeof b === "object" && (b as { type?: string }).type === "thinking",
      );
      const textBlocks = content.filter(
        (b) => b && typeof b === "object" && (b as { type?: string }).type === "text",
      );
      ctx.log.debug(
        `[DIAG3] ${evtType}: ${content.length} blocks (${thinkingBlocks.length} thinking, ${textBlocks.length} text) contentIndex=${contentIndex}`,
      );
    }
    return;
  }

  if (evtType !== "text_delta" && evtType !== "text_start" && evtType !== "text_end") {
    return;
  }

  const delta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
  const content = typeof assistantRecord?.content === "string" ? assistantRecord.content : "";
  const contentIndex =
    typeof assistantRecord?.contentIndex === "number" ? assistantRecord.contentIndex : -1;

  // [DIAG5] On text_start, snapshot the partial message's content blocks.
  // This reveals whether the API sends multiple text blocks (thinking then text)
  // that might get collapsed, or a single garbled text block from the start.
  if (evtType === "text_start") {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const blockSummary = blocks.map((b, i) => {
      const bt = b && typeof b === "object" ? ((b as { type?: string }).type ?? "?") : "?";
      if (bt === "text") {
        const t = (b as { text?: string }).text ?? "";
        return `[${i}]text:${t.length}ch:"${t.slice(0, 40).replace(/\n/g, "\\n")}"`;
      }
      if (bt === "thinking") {
        const t = (b as { thinking?: string }).thinking ?? "";
        return `[${i}]thinking:${t.length}ch`;
      }
      return `[${i}]${bt}`;
    });
    ctx.log.debug(
      `[DIAG5] text_start contentIndex=${contentIndex} totalBlocks=${blocks.length} ${blockSummary.join(" | ")}`,
    );
    appendRawStream({
      ts: Date.now(),
      event: "diag5_text_start_snapshot",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      contentIndex,
      totalBlocks: blocks.length,
      blockTypes: blocks.map((b) =>
        b && typeof b === "object" ? ((b as { type?: string }).type ?? "?") : "?",
      ),
      blockSummary,
    });
  }

  appendRawStream({
    ts: Date.now(),
    event: "assistant_text_stream",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    evtType,
    delta,
    content,
  });

  // Guard: ignore late events from content blocks we've already moved past.
  // After a content block boundary reset, a stale `text_end` from the previous
  // block would carry full block-1 content. With an empty deltaBuffer the dedup
  // logic would re-append it, recreating the overlap.
  if (
    contentIndex >= 0 &&
    ctx.state.currentTextContentIndex >= 0 &&
    contentIndex < ctx.state.currentTextContentIndex
  ) {
    ctx.log.debug(
      `Ignoring late event from content block ${contentIndex} (current: ${ctx.state.currentTextContentIndex})`,
    );
    return;
  }

  // Content block boundary: when the provider's contentIndex changes, we know a
  // new text block has started.  Flush / reset per-block accumulators so the new
  // block streams cleanly without deduplication comparing against stale text.
  if (
    contentIndex >= 0 &&
    contentIndex !== ctx.state.currentTextContentIndex &&
    ctx.state.currentTextContentIndex >= 0
  ) {
    ctx.log.debug(
      `Content block transition: index ${ctx.state.currentTextContentIndex} → ${contentIndex}`,
    );
    if (ctx.blockChunker) {
      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
      ctx.blockChunker.reset();
    } else if (ctx.state.blockBuffer.length > 0) {
      ctx.emitBlockChunk(ctx.state.blockBuffer);
      ctx.state.blockBuffer = "";
    }
    // Reset per-block streaming accumulators. After this reset, partial reply
    // consumers (onPartialReply, onAgentEvent) will see per-block text, not
    // cumulative message text. This is correct for streaming: each content block
    // starts its own text progression. The backward-movement guard (below) is
    // safe because previousCleaned will be "" after reset, short-circuiting the
    // startsWith check.
    ctx.state.deltaBuffer = "";
    ctx.state.lastStreamedAssistantCleaned = undefined;
    ctx.state.emittedAssistantUpdate = false;
    ctx.state.partialBlockState = {
      thinking: false,
      final: false,
      inlineCode: createInlineCodeState(),
    };
    // Insert a newline separator in the cumulative text buffer so that text from
    // different content blocks doesn't smash together (matching the "\n" join that
    // extractAssistantText uses at message_end).
    if (ctx.state.cumulativeStreamedText.length > 0) {
      ctx.state.cumulativeStreamedText += "\n";
    }
    // Note: blockState is NOT reset here — it tracks cumulative tag state across
    // the entire message (e.g. a <think> opened in block 1 must still be tracked
    // in block 2). Only partialBlockState is per-block.
    ctx.log.debug(
      `Content block ${contentIndex} started (previous was ${ctx.state.currentTextContentIndex})`,
    );
  }

  // Track the current content block index.
  if (contentIndex >= 0) {
    ctx.state.currentTextContentIndex = contentIndex;
  }

  let chunk = "";
  if (evtType === "text_delta") {
    chunk = delta;
  } else if (evtType === "text_start" || evtType === "text_end") {
    if (delta) {
      chunk = delta;
    } else if (content) {
      // KNOWN: Some providers resend full content on `text_end`.
      // We only append a suffix (or nothing) to keep output monotonic.
      if (content.startsWith(ctx.state.deltaBuffer)) {
        chunk = content.slice(ctx.state.deltaBuffer.length);
      } else if (ctx.state.deltaBuffer.startsWith(content)) {
        chunk = "";
      } else if (!ctx.state.deltaBuffer.includes(content)) {
        chunk = content;
      }
    }
  }

  if (chunk) {
    ctx.state.deltaBuffer += chunk;
    if (ctx.blockChunker) {
      ctx.blockChunker.append(chunk);
    } else {
      ctx.state.blockBuffer += chunk;
    }
  }

  if (ctx.state.streamReasoning) {
    // Handle partial <think> tags: stream whatever reasoning is visible so far.
    ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
  }

  const next = ctx
    .stripBlockTags(ctx.state.deltaBuffer, {
      thinking: false,
      final: false,
      inlineCode: createInlineCodeState(),
    })
    .trim();
  if (next) {
    const visibleDelta = chunk ? ctx.stripBlockTags(chunk, ctx.state.partialBlockState) : "";
    const parsedDelta = visibleDelta ? ctx.consumePartialReplyDirectives(visibleDelta) : null;
    const parsedFull = parseReplyDirectives(stripTrailingDirective(next));
    const cleanedText = parsedFull.text;
    const mediaUrls = parsedDelta?.mediaUrls;
    const hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
    const hasAudio = Boolean(parsedDelta?.audioAsVoice);
    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";

    let shouldEmit = false;
    let deltaText = "";
    if (!cleanedText && !hasMedia && !hasAudio) {
      shouldEmit = false;
    } else if (previousCleaned && !cleanedText.startsWith(previousCleaned)) {
      shouldEmit = false;
    } else {
      deltaText = cleanedText.slice(previousCleaned.length);
      shouldEmit = Boolean(deltaText || hasMedia || hasAudio);
    }

    ctx.state.lastStreamedAssistant = next;
    ctx.state.lastStreamedAssistantCleaned = cleanedText;

    if (shouldEmit) {
      // Append new delta to cumulative message text so the `text` field in
      // agent events represents ALL text emitted in this assistant message,
      // not just the current content block.  The gateway chat layer uses
      // `text` for its buffer and final message — per-block text would lose
      // earlier blocks (the overlapping-messages bug).
      ctx.state.cumulativeStreamedText += deltaText;
      const cumulativeText = ctx.state.cumulativeStreamedText;

      emitAgentEvent({
        runId: ctx.params.runId,
        stream: "assistant",
        data: {
          text: cumulativeText,
          delta: deltaText,
          mediaUrls: hasMedia ? mediaUrls : undefined,
        },
      });
      void ctx.params.onAgentEvent?.({
        stream: "assistant",
        data: {
          text: cumulativeText,
          delta: deltaText,
          mediaUrls: hasMedia ? mediaUrls : undefined,
        },
      });
      ctx.state.emittedAssistantUpdate = true;
      if (ctx.params.onPartialReply && ctx.state.shouldEmitPartialReplies) {
        void ctx.params.onPartialReply({
          text: cumulativeText,
          mediaUrls: hasMedia ? mediaUrls : undefined,
        });
      }
    }
  }

  if (ctx.params.onBlockReply && ctx.blockChunking && ctx.state.blockReplyBreak === "text_end") {
    ctx.blockChunker?.drain({ force: false, emit: ctx.emitBlockChunk });
  }

  if (evtType === "text_end" && ctx.state.blockReplyBreak === "text_end") {
    if (ctx.blockChunker?.hasBuffered()) {
      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
      ctx.blockChunker.reset();
    } else if (ctx.state.blockBuffer.length > 0) {
      ctx.emitBlockChunk(ctx.state.blockBuffer);
      ctx.state.blockBuffer = "";
    }
  }
}

export function handleMessageEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
) {
  const msg = evt.message;
  // [DIAG-MSG-END] Log ALL message_end events
  const msgAny = msg as unknown as Record<string, unknown> | undefined;
  const contentArr = Array.isArray(msgAny?.content)
    ? (msgAny!.content as Array<{ type?: string }>)
    : [];
  appendRawStream({
    ts: Date.now(),
    event: "diag_message_end",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    role: msg?.role,
    contentBlockCount: contentArr.length,
    contentTypes: contentArr.map((b) => b.type),
    cumulativeLength: ctx.state.cumulativeStreamedText.length,
    assistantTextsCount: ctx.state.assistantTexts.length,
  });
  if (msg?.role !== "assistant") {
    return;
  }

  const assistantMessage = msg;

  // [DIAG2] Log content block structure BEFORE promoteThinkingTagsToBlocks.
  // This diagnostic captures whether the API returned thinking blocks and whether
  // the accumulated deltaBuffer matches the API's text content.
  if (Array.isArray(assistantMessage.content)) {
    const blocks = assistantMessage.content;
    const blockSummary = blocks.map((b, i) => {
      if (b.type === "text") {
        return `[${i}]text:${b.text.length}ch:"${b.text.slice(0, 60).replace(/\n/g, "\\n")}..."`;
      }
      if (b.type === "thinking") {
        return `[${i}]thinking:${b.thinking.length}ch`;
      }
      if (b.type === "toolCall") {
        return `[${i}]toolCall:${b.name}`;
      }
      return `[${i}]unknown`;
    });
    // Collect all text from API content blocks
    const apiTextBlocks = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    const apiFullText = apiTextBlocks.join("\n");
    const deltaBuffer = ctx.state.deltaBuffer;
    const cumText = ctx.state.cumulativeStreamedText;
    // Check if deltaBuffer matches the last text block (for single-block messages)
    const lastApiText = apiTextBlocks.length > 0 ? apiTextBlocks[apiTextBlocks.length - 1] : "";
    const deltaMatchesApi = deltaBuffer === lastApiText;
    const apiFirst80 = apiFullText.slice(0, 80).replace(/\n/g, "\\n");
    const deltaFirst80 = deltaBuffer.slice(0, 80).replace(/\n/g, "\\n");
    const cumFirst80 = cumText.slice(0, 80).replace(/\n/g, "\\n");
    ctx.log.debug(`[DIAG2] message_end blocks=${blocks.length} ${blockSummary.join(" | ")}`);
    ctx.log.debug(
      `[DIAG2] deltaBuffer=${deltaBuffer.length}ch deltaMatchesApi=${deltaMatchesApi} apiText=${apiFullText.length}ch textBlocks=${apiTextBlocks.length}`,
    );
    if (!deltaMatchesApi || apiTextBlocks.length > 1) {
      ctx.log.debug(`[DIAG2] API first 80: "${apiFirst80}"`);
      ctx.log.debug(`[DIAG2] delta first 80: "${deltaFirst80}"`);
      ctx.log.debug(`[DIAG2] cumulative first 80: "${cumFirst80}"`);
    }
    // Also write to raw stream for post-hoc analysis
    appendRawStream({
      ts: Date.now(),
      event: "diag2_message_end_pre_promote",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      blockCount: blocks.length,
      blockTypes: blocks.map((b) => b.type),
      textBlockLengths: apiTextBlocks.map((t) => t.length),
      deltaBufferLength: deltaBuffer.length,
      deltaMatchesApi,
      apiFirst200: apiFullText.slice(0, 200),
      deltaFirst200: deltaBuffer.slice(0, 200),
      cumulativeFirst200: cumText.slice(0, 200),
    });

    // [DIAG4] Garble detection heuristic: "Let me [verb]" preamble followed by garble signature
    // (period then lowercase/special char). Trigger whether or not delta matches API — the API
    // itself may return a single garbled text block.
    const startsWithLetMe = apiFullText.startsWith("Let me ");
    const garblePattern = /\w\.\w/;
    const apiShort = apiFullText.slice(0, 500);
    const garbleDetected = startsWithLetMe && garblePattern.test(apiShort.slice(20));
    if (garbleDetected) {
      ctx.log.debug(
        `[DIAG4] ⚠️ GARBLE DETECTED! deltaBuffer(${deltaBuffer.length}) apiText(${apiFullText.length}) deltaMatchesApi=${deltaMatchesApi}`,
      );
      ctx.log.debug(`[DIAG4] API first 500: "${apiShort.replace(/\n/g, "\\n")}"`);
      ctx.log.debug(
        `[DIAG4] deltaBuffer first 500: "${deltaBuffer.slice(0, 500).replace(/\n/g, "\\n")}"`,
      );
      ctx.log.debug(
        `[DIAG4] cumulative first 500: "${cumText.slice(0, 500).replace(/\n/g, "\\n")}"`,
      );
      appendRawStream({
        ts: Date.now(),
        event: "diag4_garble_detected",
        runId: ctx.params.runId,
        sessionId: (ctx.params.session as { id?: string }).id,
        apiFullLength: apiFullText.length,
        deltaBufferLength: deltaBuffer.length,
        deltaMatchesApi,
        textBlockCount: apiTextBlocks.length,
        apiFirst500: apiShort,
        deltaFirst500: deltaBuffer.slice(0, 500),
        cumulativeFirst500: cumText.slice(0, 500),
      });
    }
  }

  promoteThinkingTagsToBlocks(assistantMessage);

  const rawText = extractAssistantText(assistantMessage);
  appendRawStream({
    ts: Date.now(),
    event: "assistant_message_end",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    rawText,
    rawThinking: extractAssistantThinking(assistantMessage),
  });

  const text = ctx.stripBlockTags(rawText, { thinking: false, final: false });
  const rawThinking =
    ctx.state.includeReasoning || ctx.state.streamReasoning
      ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
      : "";
  const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking) : "";
  const trimmedText = text.trim();
  const parsedText = trimmedText ? parseReplyDirectives(stripTrailingDirective(trimmedText)) : null;
  let cleanedText = parsedText?.text ?? "";
  let mediaUrls = parsedText?.mediaUrls;
  let hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);

  if (!cleanedText && !hasMedia) {
    const rawTrimmed = rawText.trim();
    const rawStrippedFinal = rawTrimmed.replace(/<\s*\/?\s*final\s*>/gi, "").trim();
    const rawCandidate = rawStrippedFinal || rawTrimmed;
    if (rawCandidate) {
      const parsedFallback = parseReplyDirectives(stripTrailingDirective(rawCandidate));
      cleanedText = parsedFallback.text ?? rawCandidate;
      mediaUrls = parsedFallback.mediaUrls;
      hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
    }
  }

  if (!ctx.state.emittedAssistantUpdate && (cleanedText || hasMedia)) {
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "assistant",
      data: {
        text: cleanedText,
        delta: cleanedText,
        mediaUrls: hasMedia ? mediaUrls : undefined,
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "assistant",
      data: {
        text: cleanedText,
        delta: cleanedText,
        mediaUrls: hasMedia ? mediaUrls : undefined,
      },
    });
    ctx.state.emittedAssistantUpdate = true;
  }

  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
  ctx.finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered });

  const onBlockReply = ctx.params.onBlockReply;
  const shouldEmitReasoning = Boolean(
    ctx.state.includeReasoning &&
    formattedReasoning &&
    onBlockReply &&
    formattedReasoning !== ctx.state.lastReasoningSent,
  );
  const shouldEmitReasoningBeforeAnswer =
    shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" && !addedDuringMessage;
  const maybeEmitReasoning = () => {
    if (!shouldEmitReasoning || !formattedReasoning) {
      return;
    }
    ctx.state.lastReasoningSent = formattedReasoning;
    void onBlockReply?.({ text: formattedReasoning });
  };

  if (shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
  }

  if (
    (ctx.state.blockReplyBreak === "message_end" ||
      (ctx.blockChunker ? ctx.blockChunker.hasBuffered() : ctx.state.blockBuffer.length > 0)) &&
    text &&
    onBlockReply
  ) {
    if (ctx.blockChunker?.hasBuffered()) {
      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
      ctx.blockChunker.reset();
    } else if (text !== ctx.state.lastBlockReplyText) {
      // Check for duplicates before emitting (same logic as emitBlockChunk).
      const normalizedText = normalizeTextForComparison(text);
      if (
        isMessagingToolDuplicateNormalized(
          normalizedText,
          ctx.state.messagingToolSentTextsNormalized,
        )
      ) {
        ctx.log.debug(
          `Skipping message_end block reply - already sent via messaging tool: ${text.slice(0, 50)}...`,
        );
      } else {
        ctx.state.lastBlockReplyText = text;
        const splitResult = ctx.consumeReplyDirectives(text, { final: true });
        if (splitResult) {
          const {
            text: cleanedText,
            mediaUrls,
            audioAsVoice,
            replyToId,
            replyToTag,
            replyToCurrent,
          } = splitResult;
          // Emit if there's content OR audioAsVoice flag (to propagate the flag).
          if (cleanedText || (mediaUrls && mediaUrls.length > 0) || audioAsVoice) {
            void onBlockReply({
              text: cleanedText,
              mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
              audioAsVoice,
              replyToId,
              replyToTag,
              replyToCurrent,
            });
          }
        }
      }
    }
  }

  if (!shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
  }
  if (ctx.state.streamReasoning && rawThinking) {
    ctx.emitReasoningStream(rawThinking);
  }

  if (ctx.state.blockReplyBreak === "text_end" && onBlockReply) {
    const tailResult = ctx.consumeReplyDirectives("", { final: true });
    if (tailResult) {
      const {
        text: cleanedText,
        mediaUrls,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      } = tailResult;
      if (cleanedText || (mediaUrls && mediaUrls.length > 0) || audioAsVoice) {
        void onBlockReply({
          text: cleanedText,
          mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        });
      }
    }
  }

  ctx.state.deltaBuffer = "";
  ctx.state.blockBuffer = "";
  ctx.blockChunker?.reset();
  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();
  ctx.state.lastStreamedAssistant = undefined;
  ctx.state.lastStreamedAssistantCleaned = undefined;
}
