import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { splitReadAloudBlocks } from "@t3tools/shared/readAloudBlocks";

import { makeNarrationAssembler, narrationContext, verbatimOpening } from "./narration.ts";

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

function assemble(
  blockCount: number,
  drafts: ReadonlyArray<ReturnType<typeof segment>>,
  firstBlock = 0,
) {
  const assembler = makeNarrationAssembler(blockCount, firstBlock);
  const segments = drafts.flatMap((draft) => assembler.push(draft) ?? []);
  const last = assembler.finish();
  return last ? [...segments, last] : segments;
}

describe("makeNarrationAssembler", () => {
  it("keeps a complete, ordered cover as is", () => {
    const assembled = assemble(4, [segment(0, 1), segment(2, 2), segment(3, 3)]);
    expect(ranges(assembled)).toEqual([
      [0, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("covers every block exactly once whatever the model returns", () => {
    const assembled = assemble(8, [
      segment(0, 2),
      segment(1, 3), // overlaps the previous one
      segment(2, 2), // already covered
      // 4 is missing
      segment(5, 9), // runs past the end
    ]);
    expect(ranges(assembled)).toEqual([
      [0, 2],
      [3, 4],
      [5, 7],
    ]);
  });

  it("starts at the first block it owns and ends at the last block", () => {
    expect(ranges(assemble(5, [segment(2, 3)]))).toEqual([[0, 4]]);
    expect(ranges(assemble(5, [segment(0, 2), segment(3, 3)], 2))).toEqual([
      [2, 2],
      [3, 4],
    ]);
  });

  it("holds a segment back until the next draft settles its range", () => {
    const assembler = makeNarrationAssembler(4);
    expect(assembler.push(segment(0, 0))).toBeNull();
    expect(assembler.push(segment(2, 3))).toEqual(segment(0, 1, "blocks 0-0"));
    expect(assembler.finish()).toEqual(segment(2, 3));
  });

  it("folds segments with nothing to say into a neighbor", () => {
    const assembled = assemble(4, [
      segment(0, 0, "   "),
      segment(1, 1, "First words."),
      segment(2, 2, ""),
      segment(3, 3, "Last words."),
    ]);
    expect(assembled).toEqual([
      { firstBlock: 0, lastBlock: 2, speech: "First words." },
      { firstBlock: 3, lastBlock: 3, speech: "Last words." },
    ]);
  });

  it("normalizes swapped ranges and whitespace", () => {
    expect(assemble(2, [segment(1, 0, " Both\n blocks. ")])).toEqual([
      { firstBlock: 0, lastBlock: 1, speech: "Both blocks." },
    ]);
  });

  it("returns nothing when there is nothing to say", () => {
    expect(assemble(3, [segment(0, 2, "")])).toEqual([]);
    expect(assemble(3, [])).toEqual([]);
  });
});

describe("verbatimOpening", () => {
  it("reads leading prose as written until there is enough to cover the wait", () => {
    const short = "Fixed it.";
    const long = "The uploader now waits longer between each retry. ".repeat(5).trim();
    const opening = verbatimOpening(
      splitReadAloudBlocks(`# Retries\n\n${short}\n\n${long}\n\nMore prose.`),
    );
    expect(opening.map((part) => part.speech)).toEqual(["Retries", short, long]);
    expect(ranges(opening)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("stops at the first block that needs explaining", () => {
    expect(verbatimOpening(splitReadAloudBlocks("```ts\nretry()\n```\n\nIt retries."))).toEqual([]);
    expect(verbatimOpening(splitReadAloudBlocks("Done:\n\n- one\n- two"))).toEqual([
      { firstBlock: 0, lastBlock: 0, speech: "Done:" },
    ]);
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
      subject: {
        kind: "reply",
        threadTitle: "Retry flaky uploads",
        userPrompt: "why not retry?",
        previousExchange: { user: "Why do uploads fail?", assistant: "They time out." },
        changedFiles: ["src/upload.ts", "src/retry.ts"],
      },
    });
  });

  it("has no previous exchange for the first reply", () => {
    const context = narrationContext(projection(items), MessageId.make("a1"));
    expect(context?.subject).toMatchObject({ userPrompt: "Why do uploads fail?" });
    expect(context?.subject).not.toHaveProperty("previousExchange");
  });

  it("skips missing, streaming, and empty messages", () => {
    const streaming = [{ ...items[4], streaming: true }];
    const empty = [{ ...items[4], text: "  " }];
    expect(narrationContext(projection(items), MessageId.make("missing"))).toBeUndefined();
    expect(narrationContext(projection(streaming), MessageId.make("a2"))).toBeUndefined();
    expect(narrationContext(projection(empty), MessageId.make("a2"))).toBeUndefined();
  });
});
