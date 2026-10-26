import type { MessageId, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { verbatimSpeech, type ReadAloudBlock } from "@t3tools/shared/readAloudBlocks";
import type {
  NarrationSegmentDraft,
  NarrationSubject,
} from "@t3tools/provider-core/server/textGeneration";

export interface NarrationSegment {
  readonly firstBlock: number;
  readonly lastBlock: number;
  readonly speech: string;
}

export interface NarrationAssembler {
  /** Takes the model's next draft; returns a segment once its range can no longer change. */
  readonly push: (draft: NarrationSegmentDraft) => NarrationSegment | null;
  /** The last segment, stretched to the final block; null when nothing was said. */
  readonly finish: () => NarrationSegment | null;
}

/**
 * Model output is advisory, and it arrives one draft at a time. Every block
 * from `firstBlock` on must belong to exactly one segment, in order, or the
 * highlight skips or repeats text. Drafts behind the covered range are dropped,
 * ranges past the end are clamped, and a gap joins the segment before it (or
 * the first segment), since a highlight with no matching words beats one that
 * jumps over text. Drafts with nothing to say merge into a neighbor. A segment
 * is held back until the next draft arrives, because a gap can still extend it.
 */
export function makeNarrationAssembler(blockCount: number, firstBlock = 0): NarrationAssembler {
  const last = blockCount - 1;
  const clamp = (value: number) => Math.min(Math.max(Math.trunc(value), firstBlock), last);
  let pending: { firstBlock: number; lastBlock: number; speech: string } | null = null;
  let next = firstBlock;
  return {
    push: (draft) => {
      if (next > last) return null;
      const first = clamp(Math.min(draft.firstBlock, draft.lastBlock));
      const lastBlock = clamp(Math.max(draft.firstBlock, draft.lastBlock));
      if (lastBlock < next) return null;
      next = lastBlock + 1;
      const speech = draft.speech.replace(/\s+/g, " ").trim();
      if (speech.length === 0) {
        // Keep its blocks covered without an empty clip; the next segment takes them otherwise.
        if (pending) pending.lastBlock = lastBlock;
        return null;
      }
      const done = pending;
      if (done && first > done.lastBlock + 1) done.lastBlock = first - 1;
      pending = { firstBlock: done ? done.lastBlock + 1 : firstBlock, lastBlock, speech };
      return done;
    },
    finish: () => {
      const done = pending;
      pending = null;
      if (done) done.lastBlock = last;
      return done;
    },
  };
}

const VERBATIM_OPENING_CHARS = 240;
const VERBATIM_BLOCK_MAX_CHARS = 600;

/**
 * The prose a narration opens with, read as written while the model rewrites
 * the rest, so speech starts without waiting for it. Stops at the first block
 * that needs explaining (code, a table, a list) or once there is enough to
 * cover the wait. One segment per block keeps the highlight precise.
 */
export function verbatimOpening(blocks: ReadonlyArray<ReadAloudBlock>): Array<NarrationSegment> {
  const segments: Array<NarrationSegment> = [];
  let chars = 0;
  for (const [index, block] of blocks.entries()) {
    if (chars >= VERBATIM_OPENING_CHARS || block.source.length > VERBATIM_BLOCK_MAX_CHARS) break;
    const speech = verbatimSpeech(block);
    if (speech === null) break;
    segments.push({ firstBlock: index, lastBlock: index, speech });
    chars += speech.length;
  }
  return segments;
}

export interface NarrationContext {
  readonly text: string;
  readonly subject: NarrationSubject;
}

type VisibleItem = OrchestrationV2ThreadProjection["visibleTurnItems"][number]["item"];
type MessageItem = Extract<VisibleItem, { type: "user_message" | "assistant_message" }>;

function isMessageItem(item: VisibleItem): item is MessageItem {
  return item.type === "user_message" || item.type === "assistant_message";
}

/**
 * The narrated message plus what a listener needs to follow it: the request it
 * answers, the exchange before that, and the files its run changed. Returns
 * undefined when the message is missing, still streaming, or empty.
 */
export function narrationContext(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "visibleTurnItems" | "checkpoints">,
  messageId: MessageId,
): NarrationContext | undefined {
  const messages = projection.visibleTurnItems.map(({ item }) => item).filter(isMessageItem);
  const index = messages.findIndex(
    (item) => item.type === "assistant_message" && item.messageId === messageId,
  );
  const message = messages[index];
  if (!message || message.type !== "assistant_message" || message.streaming) return undefined;
  if (message.text.trim().length === 0) return undefined;

  const userIndex = messages.findLastIndex(
    (item, position) => position < index && item.type === "user_message",
  );
  const userPrompt = userIndex >= 0 ? (messages[userIndex]?.text ?? "") : "";
  const previousAssistant =
    userIndex > 0
      ? messages.findLast(
          (item, position) => position < userIndex && item.type === "assistant_message",
        )
      : undefined;
  const previousUserIndex =
    userIndex > 0
      ? messages.findLastIndex(
          (item, position) => position < userIndex && item.type === "user_message",
        )
      : -1;
  const previousUser = previousUserIndex >= 0 ? messages[previousUserIndex] : undefined;

  const changedFiles =
    message.runId === null
      ? []
      : [
          ...new Set(
            projection.checkpoints
              .filter((checkpoint) => checkpoint.runId === message.runId)
              .flatMap((checkpoint) => checkpoint.files.map((file) => file.path)),
          ),
        ];

  return {
    text: message.text,
    subject: {
      kind: "reply",
      threadTitle: projection.thread.title,
      userPrompt,
      ...(previousUser && previousAssistant
        ? { previousExchange: { user: previousUser.text, assistant: previousAssistant.text } }
        : {}),
      changedFiles,
    },
  };
}
