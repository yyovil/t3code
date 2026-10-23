import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MessageId,
  ReadAloudSegment,
  ReadAloudSpeed,
  ThreadId,
} from "@t3tools/contracts";
import {
  READ_ALOUD_OFFSET_ATTRIBUTE,
  splitReadAloudBlocks,
  type ReadAloudBlock,
} from "@t3tools/shared/readAloudBlocks";

import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";
import {
  highlightedOffsets,
  highlightStyleSheet,
  messageRootSelector,
  splitSentences,
  spokenSentenceIndex,
} from "./readAloud.logic";
import { readAloudPrepare } from "./readAloudCommands";

export interface ReadAloudTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
}

export type ReadAloudState =
  | { readonly status: "idle" }
  | { readonly status: "preparing"; readonly target: ReadAloudTarget }
  | {
      readonly status: "active";
      readonly target: ReadAloudTarget;
      readonly segmentCount: number;
      readonly index: number;
      readonly paused: boolean;
      /** Waiting for audio: the first bytes of a segment, or a stalled stream. */
      readonly buffering: boolean;
      readonly caption: string;
    };

const IDLE: ReadAloudState = { status: "idle" };
const PREFETCH_AHEAD = 2;
const RESTART_THRESHOLD_SECONDS = 2;

interface Session {
  readonly id: number;
  readonly target: ReadAloudTarget;
  readonly httpBaseUrl: string;
  readonly blocks: ReadonlyArray<ReadAloudBlock>;
  segments: ReadonlyArray<ReadAloudSegment>;
  sentences: ReadonlyArray<ReadonlyArray<string>>;
  readonly audio: Map<number, HTMLAudioElement>;
  readonly retried: Set<number>;
}

/**
 * The app plays one narration at a time, owned here rather than by a message
 * row: the timeline virtualizes rows, and playback must outlive them. Rows and
 * the transport bar subscribe; highlighting is a stylesheet keyed by message,
 * so a row that remounts picks it up without asking.
 */
class ReadAloudPlayer {
  private state: ReadAloudState = IDLE;
  private session: Session | null = null;
  private nextSessionId = 0;
  private rate: ReadAloudSpeed = 1;
  private readonly listeners = new Set<() => void>();
  private styleElement: HTMLStyleElement | null = null;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.state;

  private setState(state: ReadAloudState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private patchActive(patch: Partial<Extract<ReadAloudState, { status: "active" }>>) {
    if (this.state.status !== "active") return;
    this.setState({ ...this.state, ...patch });
  }

  isTarget(messageId: MessageId): boolean {
    return this.state.status !== "idle" && this.state.target.messageId === messageId;
  }

  /** Starts a narration, or pauses and resumes the one already playing this message. */
  toggle(target: ReadAloudTarget, rate: ReadAloudSpeed) {
    if (this.isTarget(target.messageId)) {
      if (this.state.status === "active") this.setPaused(!this.state.paused);
      return;
    }
    void this.start(target, rate);
  }

  private async start(target: ReadAloudTarget, rate: ReadAloudSpeed) {
    this.stop();
    const connection = readPreparedConnection(target.environmentId);
    if (!connection) {
      toastManager.add({
        type: "error",
        title: "Could not read aloud",
        description: "Reconnect to this environment and try again.",
      });
      return;
    }
    this.rate = rate;
    const session: Session = {
      id: ++this.nextSessionId,
      target,
      httpBaseUrl: connection.httpBaseUrl,
      blocks: splitReadAloudBlocks(target.text),
      segments: [],
      sentences: [],
      audio: new Map(),
      retried: new Set(),
    };
    this.session = session;
    this.setState({ status: "preparing", target });

    const result = await runAtomCommand(
      appAtomRegistry,
      readAloudPrepare,
      {
        environmentId: target.environmentId,
        input: { threadId: target.threadId, messageId: target.messageId },
      },
      { reportFailure: false },
    );
    if (this.session !== session) return;
    if (result._tag === "Failure") {
      this.stop();
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not read aloud",
        description: error instanceof Error ? error.message : "The narration failed.",
      });
      return;
    }
    if (result.value.segments.length === 0) {
      this.stop();
      return;
    }
    session.segments = result.value.segments;
    session.sentences = result.value.segments.map((segment) => splitSentences(segment.speech));
    this.setState({
      status: "active",
      target,
      segmentCount: session.segments.length,
      index: 0,
      paused: false,
      buffering: true,
      caption: session.sentences[0]?.[0] ?? "",
    });
    this.playSegment(0);
  }

  stop() {
    const session = this.session;
    this.session = null;
    if (session) {
      for (const audio of session.audio.values()) releaseAudio(audio);
      session.audio.clear();
    }
    this.renderHighlight(null);
    if (this.state.status !== "idle") this.setState(IDLE);
  }

  /** For Escape: reports whether there was anything to stop. */
  stopIfActive(): boolean {
    if (this.state.status === "idle") return false;
    this.stop();
    return true;
  }

  /** Narration belongs to the thread on screen; leaving it ends the narration. */
  stopUnlessThread(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
    if (this.state.status === "idle") return;
    const { target } = this.state;
    if (target.environmentId !== environmentId || target.threadId !== threadId) this.stop();
  }

  setPaused(paused: boolean) {
    const session = this.session;
    if (!session || this.state.status !== "active") return;
    const audio = session.audio.get(this.state.index);
    if (paused) audio?.pause();
    else if (audio) void this.play(session, this.state.index, audio);
    this.patchActive({ paused });
  }

  setRate(rate: ReadAloudSpeed) {
    this.rate = rate;
    for (const audio of this.session?.audio.values() ?? []) audio.playbackRate = rate;
  }

  next() {
    if (this.state.status !== "active") return;
    if (this.state.index + 1 >= this.state.segmentCount) {
      this.stop();
      return;
    }
    this.playSegment(this.state.index + 1);
  }

  previous() {
    const session = this.session;
    if (!session || this.state.status !== "active") return;
    const current = session.audio.get(this.state.index);
    if (this.state.index === 0 || (current?.currentTime ?? 0) > RESTART_THRESHOLD_SECONDS) {
      if (current) current.currentTime = 0;
      this.playSegment(this.state.index);
      return;
    }
    this.playSegment(this.state.index - 1);
  }

  private audioUrl(session: Session, index: number): string | null {
    const segment = session.segments[index];
    return segment ? resolveAssetUrl(session.httpBaseUrl, segment.audioUrl) : null;
  }

  /** The same element prefetches and plays a segment, so it is synthesized once. */
  private audioFor(session: Session, index: number): HTMLAudioElement | null {
    const existing = session.audio.get(index);
    if (existing && existing.error === null) return existing;
    if (existing) releaseAudio(existing);
    const url = this.audioUrl(session, index);
    if (!url) return null;
    const audio = new Audio();
    audio.preload = "auto";
    audio.preservesPitch = true;
    audio.playbackRate = this.rate;
    const isCurrent = () =>
      this.session === session && this.state.status === "active" && this.state.index === index;
    audio.addEventListener("ended", () => {
      if (isCurrent()) this.next();
    });
    audio.addEventListener("waiting", () => {
      if (isCurrent()) this.patchActive({ buffering: true });
    });
    audio.addEventListener("playing", () => {
      if (isCurrent()) this.patchActive({ buffering: false });
    });
    audio.addEventListener("timeupdate", () => {
      if (!isCurrent()) return;
      const sentences = session.sentences[index] ?? [];
      const caption =
        sentences[spokenSentenceIndex(sentences, audio.currentTime, audio.duration)] ?? "";
      if (this.state.status === "active" && this.state.caption !== caption) {
        this.patchActive({ caption });
      }
    });
    audio.addEventListener("error", () => {
      if (isCurrent()) void this.recover(session, index, url);
    });
    audio.src = url;
    session.audio.set(index, audio);
    return audio;
  }

  private playSegment(index: number) {
    const session = this.session;
    if (!session || this.state.status !== "active") return;
    const audio = this.audioFor(session, index);
    if (!audio) return;
    for (const [other, element] of session.audio) {
      if (other === index) continue;
      element.pause();
      // Keep the one behind for "previous"; anything further back is done.
      if (other < index - 1) {
        releaseAudio(element);
        session.audio.delete(other);
      }
    }
    if (audio.currentTime > 0 && audio.ended) audio.currentTime = 0;
    this.patchActive({
      index,
      buffering: audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
      caption: session.sentences[index]?.[0] ?? "",
    });
    if (!this.state.paused) void this.play(session, index, audio);
    for (let ahead = 1; ahead <= PREFETCH_AHEAD; ahead++) this.audioFor(session, index + ahead);
    this.renderHighlight(session, index, true);
  }

  private async play(session: Session, index: number, audio: HTMLAudioElement) {
    try {
      await audio.play();
    } catch (error) {
      // Pausing or skipping before playback starts rejects the pending play().
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (this.session !== session || this.state.status !== "active") return;
      if (this.state.index === index) this.patchActive({ paused: true, buffering: false });
    }
  }

  /** Media errors carry no reason, so ask the server for it with a plain request. */
  private async recover(session: Session, index: number, url: string) {
    const response = await fetch(url).catch(() => null);
    if (this.session !== session) return;
    if (response?.ok && !session.retried.has(index)) {
      // A transient failure; the audio is cached on the server now.
      session.retried.add(index);
      session.audio.get(index)?.removeAttribute("src");
      session.audio.delete(index);
      this.playSegment(index);
      return;
    }
    const message = response
      ? await response
          .json()
          .then((body: unknown) =>
            typeof body === "object" && body !== null && "message" in body
              ? String(body.message)
              : null,
          )
          .catch(() => null)
      : "Could not reach the server.";
    this.stop();
    toastManager.add({
      type: "error",
      title: "Read aloud stopped",
      description: message ?? "The audio could not be played.",
    });
  }

  private renderHighlight(session: null): void;
  private renderHighlight(session: Session, index: number, scroll: boolean): void;
  private renderHighlight(session: Session | null, index = 0, scroll = false) {
    const segment = session?.segments[index];
    if (!session || !segment) {
      if (this.styleElement) this.styleElement.textContent = "";
      return;
    }
    const root = document.querySelector(messageRootSelector(session.target.messageId));
    const rendered = root
      ? [...root.querySelectorAll(`[${READ_ALOUD_OFFSET_ATTRIBUTE}]`)].map((element) =>
          Number(element.getAttribute(READ_ALOUD_OFFSET_ATTRIBUTE)),
        )
      : [];
    const offsets = highlightedOffsets(
      session.blocks,
      segment.firstBlock,
      segment.lastBlock,
      rendered,
    );
    this.styleElement ??= document.head.appendChild(document.createElement("style"));
    this.styleElement.textContent = highlightStyleSheet(session.target.messageId, offsets);
    if (!scroll || !root || offsets.length === 0) return;
    const first = root.querySelector(`[${READ_ALOUD_OFFSET_ATTRIBUTE}="${offsets[0]}"]`);
    if (first instanceof HTMLElement) scrollIntoViewIfHidden(first);
  }
}

function releaseAudio(audio: HTMLAudioElement) {
  audio.pause();
  // Dropping the source ends any download still running for it.
  audio.removeAttribute("src");
  audio.load();
}

function scrollContainer(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll") return parent;
  }
  return null;
}

function scrollIntoViewIfHidden(element: HTMLElement) {
  const container = scrollContainer(element);
  const bounds = container?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
    height: window.innerHeight,
  };
  const rect = element.getBoundingClientRect();
  // The composer floats over the bottom of the timeline.
  const visibleBottom = bounds.bottom - bounds.height * 0.25;
  if (rect.top >= bounds.top && rect.bottom <= visibleBottom) return;
  element.scrollIntoView({
    behavior: "smooth",
    block: rect.height > bounds.height * 0.5 ? "start" : "center",
  });
}

export const readAloudPlayer = new ReadAloudPlayer();
