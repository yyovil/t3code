import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ReadAloudPrepareInput,
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
import { readThreadShell } from "../state/entities";
import { readPreparedConnection } from "../state/session";
import {
  highlightedOffsets,
  highlightStyleSheet,
  readAloudKey,
  readAloudRootSelector,
  splitSentences,
  spokenSentenceIndex,
  type ReadAloudSource,
} from "./readAloud.logic";
import { readAloudPrepare } from "./readAloudCommands";

export interface ReadAloudTarget {
  readonly environmentId: EnvironmentId;
  /** The thread on screen; narration ends when it changes. */
  readonly threadId: ThreadId;
  readonly source: ReadAloudSource;
  /** The markdown as rendered, which the highlight follows. */
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
  readonly warmed: Set<number>;
  readonly retried: Set<number>;
}

const MEDIA_SESSION_ACTIONS = ["play", "pause", "nexttrack", "previoustrack", "stop"] as const;

/**
 * The app plays one narration at a time, owned here rather than by a message
 * row: the timeline virtualizes rows, and playback must outlive them. Rows and
 * the transport bar subscribe; highlighting is a stylesheet keyed by message,
 * so a row that remounts picks it up without asking.
 *
 * Every segment plays through one audio element. WebKit (all iOS browsers)
 * lets an element play with sound only once a user gesture has touched it,
 * and narration starts after seconds of preparation, long past the tap. So the
 * element is created and unlocked synchronously inside the first tap, then
 * reused: swapping its `src` needs no further gesture, including from an
 * `ended` handler with the screen locked, and the lock screen keeps one
 * consistent "now playing" source. Upcoming segments are warmed with plain
 * requests, since iOS ignores `preload` on elements that are not playing.
 */
class ReadAloudPlayer {
  private state: ReadAloudState = IDLE;
  private session: Session | null = null;
  private nextSessionId = 0;
  private rate: ReadAloudSpeed = 1;
  private readonly listeners = new Set<() => void>();
  private styleElement: HTMLStyleElement | null = null;
  private element: HTMLAudioElement | null = null;
  /** The session and segment the element's current `src` belongs to. */
  private loaded: { readonly session: Session; readonly index: number } | null = null;
  private mediaSessionOwner: Session | null = null;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.state;

  private setState(state: ReadAloudState) {
    this.state = state;
    this.syncMediaSession();
    for (const listener of this.listeners) listener();
  }

  private patchActive(patch: Partial<Extract<ReadAloudState, { status: "active" }>>) {
    if (this.state.status !== "active") return;
    this.setState({ ...this.state, ...patch });
  }

  isTarget(key: string): boolean {
    return this.state.status !== "idle" && readAloudKey(this.state.target.source) === key;
  }

  /**
   * Starts a narration, or pauses and resumes the one already playing this
   * source. Call it from the user's tap: it unlocks audio before anything awaits.
   */
  toggle(target: ReadAloudTarget, rate: ReadAloudSpeed) {
    this.unlockAudio();
    if (this.isTarget(readAloudKey(target.source))) {
      if (this.state.status === "active") this.setPaused(!this.state.paused);
      return;
    }
    void this.start(target, rate);
  }

  /**
   * Must run synchronously within a user gesture. A `load()` or `play()` in a
   * gesture lifts WebKit's playback restrictions for the element's lifetime.
   * While a narration holds the element, the tap's own play() does that.
   */
  private unlockAudio(): HTMLAudioElement {
    const audio = (this.element ??= this.createElement());
    // Plays alongside other audio as media rather than ambient sound: ignores
    // the silent switch and keeps going with the screen locked.
    const audioSession = (navigator as { audioSession?: { type: string } }).audioSession;
    if (audioSession) audioSession.type = "playback";
    if (!audio.hasAttribute("src")) audio.load();
    return audio;
  }

  private createElement(): HTMLAudioElement {
    const audio = new Audio();
    audio.preload = "auto";
    audio.preservesPitch = true;
    const current = () => {
      const loaded = this.loaded;
      if (!loaded || this.session !== loaded.session) return null;
      if (this.state.status !== "active" || this.state.index !== loaded.index) return null;
      return loaded;
    };
    audio.addEventListener("ended", () => {
      if (current()) this.next();
    });
    audio.addEventListener("waiting", () => {
      if (current()) this.patchActive({ buffering: true });
    });
    audio.addEventListener("playing", () => {
      if (current()) this.patchActive({ buffering: false });
    });
    // The system pauses and resumes media on its own (calls, headphones,
    // Siri); keep the bar truthful.
    audio.addEventListener("pause", () => {
      if (current() && audio.paused && !audio.ended) this.patchActive({ paused: true });
    });
    audio.addEventListener("play", () => {
      if (current()) this.patchActive({ paused: false });
    });
    audio.addEventListener("timeupdate", () => {
      const loaded = current();
      if (!loaded) return;
      const sentences = loaded.session.sentences[loaded.index] ?? [];
      const caption =
        sentences[spokenSentenceIndex(sentences, audio.currentTime, audio.duration)] ?? "";
      if (this.state.status === "active" && this.state.caption !== caption) {
        this.patchActive({ caption });
      }
    });
    audio.addEventListener("error", () => {
      const loaded = current();
      if (loaded) void this.recover(loaded.session, loaded.index);
    });
    return audio;
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
    this.setRate(rate);
    const session: Session = {
      id: ++this.nextSessionId,
      target,
      httpBaseUrl: connection.httpBaseUrl,
      blocks: splitReadAloudBlocks(target.text),
      segments: [],
      sentences: [],
      warmed: new Set(),
      retried: new Set(),
    };
    this.session = session;
    this.setState({ status: "preparing", target });

    const result = await runAtomCommand(
      appAtomRegistry,
      readAloudPrepare,
      {
        environmentId: target.environmentId,
        input: prepareInput(target),
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
    this.session = null;
    this.loaded = null;
    const audio = this.element;
    if (audio?.hasAttribute("src")) {
      audio.pause();
      // Dropping the source ends any download still running for it. The
      // element stays unlocked for the next narration.
      audio.removeAttribute("src");
      audio.load();
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
    const audio = paused ? this.element : this.unlockAudio();
    if (audio && this.loaded?.session === session) {
      if (paused) audio.pause();
      else void this.play(session, this.state.index, audio);
    }
    this.patchActive({ paused });
  }

  setRate(rate: ReadAloudSpeed) {
    this.rate = rate;
    if (!this.element) return;
    // Loading a new source resets playbackRate to defaultPlaybackRate.
    this.element.defaultPlaybackRate = rate;
    this.element.playbackRate = rate;
  }

  /** From a tap, the lock screen, or the end of the previous segment. */
  next() {
    if (this.state.status !== "active") return;
    this.unlockAudio();
    if (this.state.index + 1 >= this.state.segmentCount) {
      this.stop();
      return;
    }
    this.playSegment(this.state.index + 1);
  }

  previous() {
    if (this.state.status !== "active") return;
    const audio = this.unlockAudio();
    const restart = this.state.index === 0 || audio.currentTime > RESTART_THRESHOLD_SECONDS;
    this.playSegment(restart ? this.state.index : this.state.index - 1);
  }

  private audioUrl(session: Session, index: number): string | null {
    const segment = session.segments[index];
    return segment ? resolveAssetUrl(session.httpBaseUrl, segment.audioUrl) : null;
  }

  private playSegment(index: number) {
    const session = this.session;
    if (!session || this.state.status !== "active") return;
    const url = this.audioUrl(session, index);
    if (!url) return;
    const audio = (this.element ??= this.createElement());
    if (this.loaded?.session === session && this.loaded.index === index) {
      audio.currentTime = 0;
    } else {
      this.loaded = { session, index };
      audio.src = url;
      audio.playbackRate = this.rate;
    }
    this.patchActive({
      index,
      buffering: audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
      caption: session.sentences[index]?.[0] ?? "",
    });
    if (!this.state.paused) void this.play(session, index, audio);
    for (let ahead = 1; ahead <= PREFETCH_AHEAD; ahead++) this.warm(session, index + ahead);
    this.renderHighlight(session, index, true);
  }

  /**
   * Starts synthesis of a later segment. The server shares one synthesis
   * between this request and the element's, and finishes caching it after this
   * request lets go, so the response body is not needed.
   */
  private warm(session: Session, index: number) {
    if (session.warmed.has(index)) return;
    const url = this.audioUrl(session, index);
    if (!url) return;
    session.warmed.add(index);
    void fetch(url)
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }

  private async play(session: Session, index: number, audio: HTMLAudioElement) {
    try {
      await audio.play();
    } catch (error) {
      // Pausing or skipping before playback starts rejects the pending play().
      if (error instanceof DOMException && error.name === "AbortError") return;
      // NotAllowedError lands here too; the bar's play tap is a gesture that retries.
      if (this.session !== session || this.state.status !== "active") return;
      if (this.state.index === index) this.patchActive({ paused: true, buffering: false });
    }
  }

  /** Media errors carry no reason, so ask the server for it with a plain request. */
  private async recover(session: Session, index: number) {
    const url = this.audioUrl(session, index);
    const response = url ? await fetch(url).catch(() => null) : null;
    if (this.session !== session) return;
    if (response?.ok && !session.retried.has(index)) {
      // A transient failure; the audio is cached on the server now.
      session.retried.add(index);
      this.loaded = null;
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

  /** The lock screen and Control Center mirror the bar and drive the same methods. */
  private syncMediaSession() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const mediaSession = navigator.mediaSession;
    const session = this.state.status === "active" ? this.session : null;
    if (session !== this.mediaSessionOwner) {
      this.mediaSessionOwner = session;
      mediaSession.metadata = session
        ? new MediaMetadata({ title: narrationTitle(session.target), artist: "T3 Code" })
        : null;
      for (const action of MEDIA_SESSION_ACTIONS) {
        setActionHandler(mediaSession, action, session ? this.mediaActionHandler(action) : null);
      }
    }
    mediaSession.playbackState =
      this.state.status !== "active" ? "none" : this.state.paused ? "paused" : "playing";
  }

  private mediaActionHandler(action: (typeof MEDIA_SESSION_ACTIONS)[number]): () => void {
    switch (action) {
      case "play":
        return () => this.setPaused(false);
      case "pause":
        return () => this.setPaused(true);
      case "nexttrack":
        return () => this.next();
      case "previoustrack":
        return () => this.previous();
      case "stop":
        return () => this.stop();
    }
  }

  private renderHighlight(session: null): void;
  private renderHighlight(session: Session, index: number, scroll: boolean): void;
  private renderHighlight(session: Session | null, index = 0, scroll = false) {
    const segment = session?.segments[index];
    if (!session || !segment) {
      if (this.styleElement) this.styleElement.textContent = "";
      return;
    }
    const rootSelector = readAloudRootSelector(session.target.source);
    const root = document.querySelector(rootSelector);
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
    this.styleElement.textContent = highlightStyleSheet(rootSelector, offsets);
    if (!scroll || !root || offsets.length === 0) return;
    const first = root.querySelector(`[${READ_ALOUD_OFFSET_ATTRIBUTE}="${offsets[0]}"]`);
    if (first instanceof HTMLElement) scrollIntoViewIfHidden(first);
  }
}

function prepareInput(target: ReadAloudTarget): ReadAloudPrepareInput {
  return target.source.kind === "message"
    ? { threadId: target.threadId, messageId: target.source.messageId }
    : { path: target.source.path, text: target.text };
}

function narrationTitle(target: ReadAloudTarget): string {
  if (target.source.kind === "document") {
    return target.source.path.split("/").at(-1) || target.source.path;
  }
  const title = readThreadShell({
    environmentId: target.environmentId,
    threadId: target.threadId,
  })?.title.trim();
  return title || "Read aloud";
}

function setActionHandler(
  mediaSession: MediaSession,
  action: MediaSessionAction,
  handler: (() => void) | null,
) {
  try {
    mediaSession.setActionHandler(action, handler);
  } catch {
    // Browsers throw for actions they do not support.
  }
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
