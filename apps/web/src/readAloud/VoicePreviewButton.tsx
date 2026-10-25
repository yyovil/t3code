import { PauseIcon, PlayIcon } from "lucide-react";
import { type SyntheticEvent, useEffect, useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";

/**
 * One sample plays at a time, through one element, started inside the click
 * so WebKit allows it. Samples are ElevenLabs' public clips: no key, no credits.
 */
const preview = {
  audio: null as HTMLAudioElement | null,
  playing: null as string | null,
  listeners: new Set<() => void>(),
};

function setPlaying(url: string | null) {
  preview.playing = url;
  for (const listener of preview.listeners) listener();
}

function subscribe(listener: () => void) {
  preview.listeners.add(listener);
  return () => {
    preview.listeners.delete(listener);
  };
}

function stopVoicePreview() {
  preview.audio?.pause();
  setPlaying(null);
}

function toggleVoicePreview(url: string) {
  if (preview.playing === url) {
    stopVoicePreview();
    return;
  }
  if (!preview.audio) {
    const audio = new Audio();
    audio.addEventListener("ended", () => setPlaying(null));
    preview.audio = audio;
  }
  const audio = preview.audio;
  audio.src = url;
  setPlaying(url);
  audio.play().catch(() => {
    if (preview.playing === url) setPlaying(null);
  });
}

/** Stops a sample when the settings that started it go away. */
export function VoicePreviewScope() {
  useEffect(() => stopVoicePreview, []);
  return null;
}

// Inside a select option, the option must not see the press, or it selects the voice.
const swallow = (event: SyntheticEvent) => event.stopPropagation();

export function VoicePreviewButton({
  name,
  previewUrl,
}: {
  readonly name: string;
  readonly previewUrl: string;
}) {
  const playing = useSyncExternalStore(subscribe, () => preview.playing === previewUrl);
  const Icon = playing ? PauseIcon : PlayIcon;
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={playing ? `Stop ${name} sample` : `Play ${name} sample`}
      aria-pressed={playing}
      onPointerDown={swallow}
      onPointerUp={swallow}
      onMouseDown={swallow}
      onMouseUp={swallow}
      onKeyDown={swallow}
      onClick={(event) => {
        event.stopPropagation();
        toggleVoicePreview(previewUrl);
      }}
    >
      <Icon className={playing ? "size-3 text-primary" : "size-3"} />
    </Button>
  );
}
