import { READ_ALOUD_SPEEDS, type MessageId, type ReadAloudSpeed } from "@t3tools/contracts";
import { READ_ALOUD_OFFSET_ATTRIBUTE, type ReadAloudBlock } from "@t3tools/shared/readAloudBlocks";

const SENTENCE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "sentence" });
// Roughly how fast ElevenLabs voices speak at 1×, for streams whose length is not known yet.
const CHARACTERS_PER_SECOND = 15;

export function splitSentences(speech: string): ReadonlyArray<string> {
  const sentences = [...SENTENCE_SEGMENTER.segment(speech)]
    .map((part) => part.segment.trim())
    .filter((sentence) => sentence.length > 0);
  return sentences.length > 0 ? sentences : [speech];
}

/**
 * The sentence being spoken, estimated from how far through the clip playback is.
 * A clip still streaming reports an infinite duration, so its length is
 * estimated from the text until the browser knows it.
 */
export function spokenSentenceIndex(
  sentences: ReadonlyArray<string>,
  currentTime: number,
  duration: number,
): number {
  const characters = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
  if (characters === 0 || sentences.length < 2) return 0;
  const total =
    Number.isFinite(duration) && duration > 0 ? duration : characters / CHARACTERS_PER_SECOND;
  const spoken = Math.min(Math.max(currentTime / total, 0), 1) * characters;
  let reached = 0;
  for (const [index, sentence] of sentences.entries()) {
    reached += sentence.length;
    if (spoken < reached) return index;
  }
  return sentences.length - 1;
}

export function nextSpeed(speed: ReadAloudSpeed): ReadAloudSpeed {
  const index = READ_ALOUD_SPEEDS.indexOf(speed);
  return READ_ALOUD_SPEEDS[(index + 1) % READ_ALOUD_SPEEDS.length] ?? 1;
}

/**
 * Source offsets of the rendered elements to highlight for blocks
 * `[firstBlock, lastBlock]`. A block rendered inside another element (the body
 * of a raw `<details>`) highlights the closest anchored element before it.
 * Without rendered anchors (the row is not mounted) the block starts are used,
 * which match once the row renders.
 */
export function highlightedOffsets(
  blocks: ReadonlyArray<ReadAloudBlock>,
  firstBlock: number,
  lastBlock: number,
  renderedOffsets: ReadonlyArray<number>,
): ReadonlyArray<number> {
  const covered = blocks.slice(firstBlock, lastBlock + 1);
  if (renderedOffsets.length === 0) return covered.map((block) => block.start);
  const sorted = renderedOffsets.toSorted((a, b) => a - b);
  const offsets = new Set<number>();
  for (const block of covered) {
    const anchor = sorted.findLast((offset) => offset <= block.start);
    if (anchor !== undefined) offsets.add(anchor);
  }
  return [...offsets];
}

/** What a narration reads: an assistant reply, or a markdown file in the file preview. */
export type ReadAloudSource =
  | { readonly kind: "message"; readonly messageId: MessageId }
  | { readonly kind: "document"; readonly path: string };

/** Identifies a narration across the button that starts it and the bar that drives it. */
export function readAloudKey(source: ReadAloudSource): string {
  return source.kind === "message" ? `message:${source.messageId}` : `document:${source.path}`;
}

export const READ_ALOUD_DOCUMENT_ATTRIBUTE = "data-read-aloud-document";

/** The element that wraps the rendered markdown being narrated. */
export function readAloudRootSelector(source: ReadAloudSource): string {
  return source.kind === "message"
    ? `[data-assistant-citation-source="${CSS.escape(source.messageId)}"]`
    : `[${READ_ALOUD_DOCUMENT_ATTRIBUTE}="${CSS.escape(source.path)}"]`;
}

/** A static highlight: no transition, so nothing repaints while the narration plays. */
export function highlightStyleSheet(rootSelector: string, offsets: ReadonlyArray<number>): string {
  if (offsets.length === 0) return "";
  const selectors = offsets
    .map((offset) => `${rootSelector} [${READ_ALOUD_OFFSET_ATTRIBUTE}="${offset}"]`)
    .join(",\n");
  return `${selectors} {
  border-radius: 0.375rem;
  background-color: color-mix(in oklab, var(--primary) 10%, transparent);
  box-shadow: 0 0 0 0.25rem color-mix(in oklab, var(--primary) 10%, transparent);
}`;
}
