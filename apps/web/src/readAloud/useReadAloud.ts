import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { readAloudPrepare } from "./readAloudCommands";

import { readAloudKey } from "./readAloud.logic";
import { readAloudPlayer, type ReadAloudState } from "./readAloudPlayer";

export function useReadAloudState(): ReadAloudState {
  return useSyncExternalStore(readAloudPlayer.subscribe, readAloudPlayer.getSnapshot);
}

/** This source's part of the narration state, so other rows skip re-rendering. */
export function useReadAloudStatus(key: string): "idle" | "preparing" | "playing" | "paused" {
  return useSyncExternalStore(readAloudPlayer.subscribe, () => {
    const state = readAloudPlayer.getSnapshot();
    if (state.status === "idle" || readAloudKey(state.target.source) !== key) return "idle";
    if (state.status === "preparing") return "preparing";
    return state.paused ? "paused" : "playing";
  });
}

/** The narrated reply, which the timeline keeps rendered while it plays. */
export function useReadAloudMessageId(): MessageId | null {
  return useSyncExternalStore(readAloudPlayer.subscribe, () => {
    const state = readAloudPlayer.getSnapshot();
    return state.status !== "idle" && state.target.source.kind === "message"
      ? state.target.source.messageId
      : null;
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

/**
 * Whether this client may start a narration on the environment, and whether
 * the environment has a voice. Without one, the speaker opens its setting.
 */
export function useReadAloudAvailability(environmentId: EnvironmentId) {
  const configured = useEnvironmentSettings(
    environmentId,
    (settings) => settings.readAloud.elevenLabsApiKey.length > 0,
  );
  const canNarrate = useAtomValue(readAloudPrepare.permissionAtom(environmentId));
  const navigate = useNavigate();
  const openSettings = () =>
    void navigate({
      to: "/settings/integrations",
      search: { machine: environmentId },
      hash: "read-aloud",
    });
  return { canNarrate, configured, openSettings };
}
