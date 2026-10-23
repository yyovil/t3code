import { splitReadAloudBlocks } from "@t3tools/shared/readAloudBlocks";
import { describe, expect, it } from "vite-plus/test";

import {
  highlightedOffsets,
  nextSpeed,
  splitSentences,
  spokenSentenceIndex,
} from "./readAloud.logic";

describe("spokenSentenceIndex", () => {
  const sentences = splitSentences(
    "Short one. This second sentence is much longer than the first.",
  );

  it("splits speech into sentences", () => {
    expect(sentences).toEqual([
      "Short one.",
      "This second sentence is much longer than the first.",
    ]);
  });

  it("follows playback through the clip by length of text", () => {
    expect(spokenSentenceIndex(sentences, 0, 10)).toBe(0);
    expect(spokenSentenceIndex(sentences, 1, 10)).toBe(0);
    expect(spokenSentenceIndex(sentences, 3, 10)).toBe(1);
    expect(spokenSentenceIndex(sentences, 12, 10)).toBe(1);
  });

  it("estimates the length of a clip that is still streaming", () => {
    // 61 characters at the assumed 15 per second is about four seconds.
    expect(spokenSentenceIndex(sentences, 0.5, Number.POSITIVE_INFINITY)).toBe(0);
    expect(spokenSentenceIndex(sentences, 2, Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("highlightedOffsets", () => {
  const text = "Intro.\n\n<details><summary>Logs</summary>\n\nraw output\n\n</details>\n\n- a\n- b";
  const blocks = splitReadAloudBlocks(text);

  it("uses the rendered element for each block", () => {
    const rendered = blocks.map((block) => block.start);
    expect(highlightedOffsets(blocks, 3, 4, rendered)).toEqual([
      blocks[3]!.start,
      blocks[4]!.start,
    ]);
  });

  it("falls back to the element a block renders inside", () => {
    const details = blocks[1]!.start;
    const rendered = [blocks[0]!.start, details, blocks[3]!.start, blocks[4]!.start];
    expect(blocks[2]!.source).toBe("raw output");
    expect(highlightedOffsets(blocks, 2, 2, rendered)).toEqual([details]);
  });

  it("uses block starts while the row is not rendered", () => {
    expect(highlightedOffsets(blocks, 0, 1, [])).toEqual([blocks[0]!.start, blocks[1]!.start]);
  });
});

it("cycles through the playback speeds", () => {
  expect([1, 1.25, 1.5, 1.75, 2].map((speed) => nextSpeed(speed as 1))).toEqual([
    1.25, 1.5, 1.75, 2, 1,
  ]);
});
