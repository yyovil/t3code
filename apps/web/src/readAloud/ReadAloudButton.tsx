import { PauseIcon, PlayIcon, Volume2Icon } from "lucide-react";
import { use } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { TimelineRowCtx } from "../components/chat/timelineRowContext";
import { useClientSettings } from "../hooks/useSettings";
import type { ChatMessage } from "../types";
import { readAloudPlayer } from "./readAloudPlayer";
import { readAloudKey } from "./readAloud.logic";
import { useReadAloudAvailability, useReadAloudStatus } from "./useReadAloud";

export const READ_ALOUD_LABELS = {
  idle: "Read aloud",
  preparing: "Preparing narration…",
  playing: "Pause reading",
  paused: "Resume reading",
} as const;

/** Rendered beside the copy button, under the same conditions. */
export function ReadAloudButton({ message }: { readonly message: ChatMessage }) {
  const ctx = use(TimelineRowCtx);
  const environmentId = ctx.activeThreadEnvironmentId;
  const threadId = ctx.threadRef?.threadId ?? null;
  const status = useReadAloudStatus(readAloudKey({ kind: "message", messageId: message.id }));
  const speed = useClientSettings((settings) => settings.readAloudSpeed);
  const { canNarrate, configured, openSettings } = useReadAloudAvailability(environmentId);
  if (!canNarrate || threadId === null) return null;

  const label = READ_ALOUD_LABELS[status];
  const tooltip = configured
    ? label
    : "Add an ElevenLabs API key in Settings to read responses aloud";
  const Icon = status === "playing" ? PauseIcon : status === "paused" ? PlayIcon : Volume2Icon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            aria-busy={status === "preparing" || undefined}
            aria-pressed={status === "idle" ? undefined : status === "playing"}
            onClick={() => {
              if (!configured) {
                openSettings();
                return;
              }
              readAloudPlayer.toggle(
                {
                  environmentId,
                  threadId,
                  source: { kind: "message", messageId: message.id },
                  text: message.text,
                },
                speed,
              );
            }}
          />
        }
      >
        <Icon className={status === "idle" ? "size-3" : "size-3 text-primary"} />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
