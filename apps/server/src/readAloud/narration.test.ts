import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { narrationContext, repairNarrationSegments } from "./narration.ts";

const segment = (
  firstBlock: number,
  lastBlock: number,
  speech = `blocks ${firstBlock}-${lastBlock}`,
) => ({
  firstBlock,
  lastBlock,
  speech,
});

const ranges = (segments: ReadonlyArray<{ firstBlock: number; lastBlock: number }>) =>
  segments.map(({ firstBlock, lastBlock }) => [firstBlock, lastBlock]);

describe("repairNarrationSegments", () => {
  it("keeps a complete, ordered cover as is", () => {
    const repaired = repairNarrationSegments(4, [segment(0, 1), segment(2, 2), segment(3, 3)]);
    expect(ranges(repaired)).toEqual([
      [0, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("covers every block exactly once whatever the model returns", () => {
    const repaired = repairNarrationSegments(8, [
      segment(5, 9), // runs past the end
      segment(0, 2),
      segment(1, 3), // overlaps the previous one
      segment(2, 2), // already covered
      // 4 is missing
    ]);
    expect(ranges(repaired)).toEqual([
      [0, 2],
      [3, 4],
      [5, 7],
    ]);
  });

  it("starts at block zero and ends at the last block", () => {
    expect(ranges(repairNarrationSegments(5, [segment(2, 3)]))).toEqual([[0, 4]]);
  });

  it("folds segments with nothing to say into a neighbor", () => {
    const repaired = repairNarrationSegments(4, [
      segment(0, 0, "   "),
      segment(1, 1, "First words."),
      segment(2, 2, ""),
      segment(3, 3, "Last words."),
    ]);
    expect(repaired).toEqual([
      { firstBlock: 0, lastBlock: 2, speech: "First words." },
      { firstBlock: 3, lastBlock: 3, speech: "Last words." },
    ]);
  });

  it("normalizes swapped ranges and whitespace", () => {
    expect(repairNarrationSegments(2, [segment(1, 0, " Both\n blocks. ")])).toEqual([
      { firstBlock: 0, lastBlock: 1, speech: "Both blocks." },
    ]);
  });

  it("returns nothing when there is nothing to say", () => {
    expect(repairNarrationSegments(3, [segment(0, 2, "")])).toEqual([]);
    expect(repairNarrationSegments(3, [])).toEqual([]);
  });
});

describe("narrationContext", () => {
  const item = (fields: Record<string, unknown>) => ({ item: fields });
  const projection = (items: ReadonlyArray<Record<string, unknown>>) =>
    ({
      thread: { title: "Retry flaky uploads" },
      visibleTurnItems: items.map(item),
      checkpoints: [
        { runId: "run-2", files: [{ path: "src/upload.ts" }, { path: "src/retry.ts" }] },
        { runId: "run-2", files: [{ path: "src/upload.ts" }] },
        { runId: "run-1", files: [{ path: "README.md" }] },
      ],
    }) as unknown as Parameters<typeof narrationContext>[0];

  const items = [
    { type: "user_message", messageId: "u1", text: "Why do uploads fail?" },
    { type: "assistant_message", messageId: "a1", text: "They time out.", runId: "run-1" },
    { type: "user_message", messageId: "u2", text: "why not retry?" },
    { type: "reasoning", text: "thinking" },
    {
      type: "assistant_message",
      messageId: "a2",
      text: "Retries now back off.",
      runId: "run-2",
      streaming: false,
    },
  ];

  it("collects the request, the exchange before it, and the run's files", () => {
    expect(narrationContext(projection(items), MessageId.make("a2"))).toEqual({
      text: "Retries now back off.",
      threadTitle: "Retry flaky uploads",
      userPrompt: "why not retry?",
      previousExchange: { user: "Why do uploads fail?", assistant: "They time out." },
      changedFiles: ["src/upload.ts", "src/retry.ts"],
    });
  });

  it("has no previous exchange for the first reply", () => {
    const context = narrationContext(projection(items), MessageId.make("a1"));
    expect(context?.userPrompt).toBe("Why do uploads fail?");
    expect(context?.previousExchange).toBeUndefined();
  });

  it("skips missing, streaming, and empty messages", () => {
    const streaming = [{ ...items[4], streaming: true }];
    const empty = [{ ...items[4], text: "  " }];
    expect(narrationContext(projection(items), MessageId.make("missing"))).toBeUndefined();
    expect(narrationContext(projection(streaming), MessageId.make("a2"))).toBeUndefined();
    expect(narrationContext(projection(empty), MessageId.make("a2"))).toBeUndefined();
  });
});
