import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { readAloudPlayer, type ReadAloudState } from "./readAloudPlayer";

export function useReadAloudState(): ReadAloudState {
  return useSyncExternalStore(readAloudPlayer.subscribe, readAloudPlayer.getSnapshot);
}

/** This message's part of the narration state, so other rows skip re-rendering. */
export function useReadAloudMessageStatus(
  messageId: MessageId,
): "idle" | "preparing" | "playing" | "paused" {
  return useSyncExternalStore(readAloudPlayer.subscribe, () => {
    const state = readAloudPlayer.getSnapshot();
    if (state.status === "idle" || state.target.messageId !== messageId) return "idle";
    if (state.status === "preparing") return "preparing";
    return state.paused ? "paused" : "playing";
  });
}

/** The narrated message, which the timeline keeps rendered while it plays. */
export function useReadAloudMessageId(): MessageId | null {
  return useSyncExternalStore(readAloudPlayer.subscribe, () => {
    const state = readAloudPlayer.getSnapshot();
    return state.status === "idle" ? null : state.target.messageId;
  });
}

/**
 * Ends the narration when the thread on screen changes or the chat closes.
 * A component rather than a hook: a hook call in the middle of ChatView splits
 * the React Compiler's memo scopes around it, and ChatView's values then
 * change identity on every render and loop.
 */
export function ReadAloudThreadScope({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  useEffect(() => {
    readAloudPlayer.stopUnlessThread(environmentId, threadId);
    return () => readAloudPlayer.stopUnlessThread(null, null);
  }, [environmentId, threadId]);
  return null;
}
