import type { MessageId, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type {
  NarrationSegmentDraft,
  NarrationSubject,
} from "@t3tools/provider-core/server/textGeneration";

export interface NarrationSegment {
  readonly firstBlock: number;
  readonly lastBlock: number;
  readonly speech: string;
}

/**
 * Model output is advisory. Every block must belong to exactly one segment, in
 * order, or the highlight skips or repeats text. Overlaps are trimmed, ranges
 * past the end are clamped, and a gap joins the segment before it (or the one
 * after it at the start), since a highlight with no matching words beats one
 * that jumps over text. Segments with nothing to say merge into a neighbor.
 */
export function repairNarrationSegments(
  blockCount: number,
  drafts: ReadonlyArray<NarrationSegmentDraft>,
): ReadonlyArray<NarrationSegment> {
  if (blockCount <= 0) return [];
  const last = blockCount - 1;
  const clamp = (value: number) => Math.min(Math.max(Math.trunc(value), 0), last);
  const ordered = drafts
    .map((draft) => {
      const first = clamp(Math.min(draft.firstBlock, draft.lastBlock));
      return {
        firstBlock: first,
        lastBlock: clamp(Math.max(draft.firstBlock, draft.lastBlock)),
        speech: draft.speech.replace(/\s+/g, " ").trim(),
      };
    })
    .toSorted((a, b) => a.firstBlock - b.firstBlock || a.lastBlock - b.lastBlock);

  const segments: Array<{ firstBlock: number; lastBlock: number; speech: string }> = [];
  let next = 0;
  for (const draft of ordered) {
    if (draft.lastBlock < next) continue;
    const previous = segments.at(-1);
    if (draft.speech.length === 0) {
      // Keep its blocks covered without an empty clip.
      if (previous) previous.lastBlock = draft.lastBlock;
      else segments.push({ ...draft, firstBlock: 0 });
      next = draft.lastBlock + 1;
      continue;
    }
    if (draft.firstBlock > next && previous) previous.lastBlock = draft.firstBlock - 1;
    segments.push({ ...draft, firstBlock: previous ? previous.lastBlock + 1 : 0 });
    next = draft.lastBlock + 1;
  }
  const tail = segments.at(-1);
  if (tail) tail.lastBlock = last;
  // A run of empty drafts at the start leaves an empty first segment: fold it forward.
  const first = segments[0];
  const second = segments[1];
  if (first && second && first.speech.length === 0) {
    segments.splice(0, 2, { ...second, firstBlock: 0 });
  }
  return segments.filter((segment) => segment.speech.length > 0);
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
