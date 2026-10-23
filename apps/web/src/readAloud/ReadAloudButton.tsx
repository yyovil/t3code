import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { PauseIcon, PlayIcon, Volume2Icon } from "lucide-react";
import { use } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { TimelineRowCtx } from "../components/chat/timelineRowContext";
import { useClientSettings, useEnvironmentSettings } from "../hooks/useSettings";
import type { ChatMessage } from "../types";
import { readAloudPrepare } from "./readAloudCommands";
import { readAloudPlayer } from "./readAloudPlayer";
import { useReadAloudMessageStatus } from "./useReadAloud";

const LABELS = {
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
  const status = useReadAloudMessageStatus(message.id);
  const speed = useClientSettings((settings) => settings.readAloudSpeed);
  const configured = useEnvironmentSettings(
    environmentId,
    (settings) => settings.readAloud.elevenLabsApiKey.length > 0,
  );
  const canNarrate = useAtomValue(readAloudPrepare.permissionAtom(environmentId));
  const navigate = useNavigate();
  if (!canNarrate || threadId === null) return null;

  const label = configured
    ? LABELS[status]
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
                void navigate({ to: "/settings/integrations", hash: "read-aloud" });
                return;
              }
              readAloudPlayer.toggle(
                { environmentId, threadId, messageId: message.id, text: message.text },
                speed,
              );
            }}
          />
        }
      >
        <Icon className={status === "idle" ? "size-3" : "size-3 text-primary"} />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
