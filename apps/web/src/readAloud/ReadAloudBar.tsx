import {
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SquareIcon,
  Volume2Icon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ComposerBanner } from "../components/chat/ComposerBanner";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { nextSpeed } from "./readAloud.logic";
import { readAloudPlayer } from "./readAloudPlayer";
import { useReadAloudState } from "./useReadAloud";

function TransportButton({
  label,
  onClick,
  disabled,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Transport for the narration, attached above the composer while one is active. */
export function ReadAloudBar({ stopShortcut }: { readonly stopShortcut: string | null }) {
  const state = useReadAloudState();
  const speed = useClientSettings((settings) => settings.readAloudSpeed);
  if (state.status === "idle") return null;
  const active = state.status === "active" ? state : null;
  const caption =
    active === null
      ? "Preparing narration…"
      : active.buffering && active.caption.length === 0
        ? "Loading audio…"
        : active.caption;

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label="Read aloud"
        data-chat-composer-collapsed-controls="true"
        className="relative z-0"
      >
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <Volume2Icon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">
            {active ? (
              <span className="flex-none tabular-nums text-muted-foreground/70">
                {active.index + 1}/{active.segmentCount}
              </span>
            ) : null}
            <span className="min-w-0 truncate text-foreground/80" aria-live="polite">
              {caption}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions className="flex-nowrap">
            <TransportButton
              label="Previous"
              disabled={!active}
              onClick={() => readAloudPlayer.previous()}
            >
              <SkipBackIcon className="size-3.5" />
            </TransportButton>
            <TransportButton
              label={active?.paused ? "Resume" : "Pause"}
              disabled={!active}
              onClick={() => readAloudPlayer.setPaused(!active?.paused)}
            >
              {active?.paused ? (
                <PlayIcon className="size-3.5" />
              ) : (
                <PauseIcon className="size-3.5" />
              )}
            </TransportButton>
            <TransportButton label="Next" disabled={!active} onClick={() => readAloudPlayer.next()}>
              <SkipForwardIcon className="size-3.5" />
            </TransportButton>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-label={`Playback speed ${speed}×`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      const next = nextSpeed(speed);
                      readAloudPlayer.setRate(next);
                      void updateClientSettings({ readAloudSpeed: next });
                    }}
                  />
                }
              >
                <span className="min-w-8 tabular-nums">{speed}×</span>
              </TooltipTrigger>
              <TooltipPopup side="top">Playback speed</TooltipPopup>
            </Tooltip>
            <TransportButton
              label={stopShortcut ? `Stop (${stopShortcut})` : "Stop"}
              onClick={() => readAloudPlayer.stop()}
            >
              <SquareIcon className="size-3" />
            </TransportButton>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
