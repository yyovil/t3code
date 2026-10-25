import {
  READ_ALOUD_DOCUMENT_MAX_CHARS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { PauseIcon, PlayIcon, Volume2Icon } from "lucide-react";

import { FileSurfaceAction } from "../components/files/fileSurfaceChrome";
import { useClientSettings } from "../hooks/useSettings";
import { READ_ALOUD_LABELS } from "./ReadAloudButton";
import { readAloudKey } from "./readAloud.logic";
import { readAloudPlayer } from "./readAloudPlayer";
import { useReadAloudAvailability, useReadAloudStatus } from "./useReadAloud";

/** The file preview's speaker: narrates the markdown file it shows. */
export function ReadAloudDocumentButton({
  environmentId,
  threadRef,
  path,
  text,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly text: string;
}) {
  const status = useReadAloudStatus(readAloudKey({ kind: "document", path }));
  const speed = useClientSettings((settings) => settings.readAloudSpeed);
  const { canNarrate, configured, openSettings } = useReadAloudAvailability(environmentId);
  if (!canNarrate) return null;

  const tooLong = text.length > READ_ALOUD_DOCUMENT_MAX_CHARS;
  const label = !configured
    ? "Add an ElevenLabs API key in Settings to read files aloud"
    : tooLong
      ? "Too long to read aloud"
      : READ_ALOUD_LABELS[status];
  const Icon = status === "playing" ? PauseIcon : status === "paused" ? PlayIcon : Volume2Icon;

  return (
    <FileSurfaceAction
      label={label}
      disabled={configured && tooLong}
      onPress={() => {
        if (!configured) {
          openSettings();
          return;
        }
        readAloudPlayer.toggle(
          {
            environmentId,
            threadId: threadRef.threadId,
            source: { kind: "document", path },
            text,
          },
          speed,
        );
      }}
    >
      <Icon className={status === "idle" ? "size-3.5" : "size-3.5 text-primary"} />
    </FileSurfaceAction>
  );
}
