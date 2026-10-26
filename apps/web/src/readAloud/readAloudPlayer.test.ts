import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

function deferred() {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface PrepareInput {
  readonly request: unknown;
  readonly onValue: (segment: unknown) => boolean;
}

const mocks = {
  prepare: deferred(),
  prepareInputs: [] as Array<unknown>,
  onValue: (_segment: unknown) => false,
};

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (_registry: unknown, _command: unknown, request: { input: PrepareInput }) => {
    mocks.prepareInputs.push(request.input.request);
    mocks.onValue = request.input.onValue;
    return mocks.prepare.promise;
  },
  squashAtomCommandFailure: () => new Error("failed"),
}));
vi.mock("../state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "https://env.test/" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => ({ title: "Fix the flaky test" }),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./readAloudCommands", () => ({ readAloudPrepare: {} }));

class FakeAudio extends EventTarget {
  static log: Array<string> = [];
  static instances: Array<FakeAudio> = [];
  preload = "";
  preservesPitch = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  currentTime = 0;
  duration = Number.NaN;
  readyState = 0;
  paused = true;
  ended = false;
  private source: string | null = null;

  constructor() {
    super();
    FakeAudio.instances.push(this);
    FakeAudio.log.push("new");
  }
  get src() {
    return this.source ?? "";
  }
  set src(url: string) {
    this.source = url;
    // As the media load algorithm does.
    this.playbackRate = this.defaultPlaybackRate;
    FakeAudio.log.push(`src ${url}`);
  }
  hasAttribute(name: string) {
    return name === "src" && this.source !== null;
  }
  removeAttribute() {
    this.source = null;
  }
  load() {
    FakeAudio.log.push("load");
  }
  play() {
    this.paused = false;
    FakeAudio.log.push("play");
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    FakeAudio.log.push("pause");
  }
}

function createMediaSession() {
  const handlers = new Map<string, (() => void) | null>();
  return {
    handlers,
    metadata: null as { title: string; artist: string } | null,
    playbackState: "none",
    setActionHandler(action: string, handler: (() => void) | null) {
      handlers.set(action, handler);
    },
  };
}

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
const target = (id: string) => ({
  environmentId,
  threadId,
  source: { kind: "message", messageId: MessageId.make(id) } as const,
  text,
});
const segments = [0, 1, 2].map((index) => ({
  firstBlock: index,
  lastBlock: index,
  speech: `Segment ${index}.`,
  audioUrl: `/api/read-aloud/token-${index}`,
}));
const url = (index: number) => `https://env.test/api/read-aloud/token-${index}`;

async function setup() {
  vi.resetModules();
  FakeAudio.log = [];
  FakeAudio.instances = [];
  mocks.prepare = deferred();
  mocks.prepareInputs = [];
  const mediaSession = createMediaSession();
  const audioSession = { type: "auto" };
  const fetch = vi.fn((_url: string) =>
    Promise.resolve({ ok: true, body: { cancel: () => undefined } }),
  );
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("HTMLMediaElement", { HAVE_FUTURE_DATA: 3 });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(init: object) {
        Object.assign(this, init);
      }
    },
  );
  vi.stubGlobal("navigator", { mediaSession, audioSession });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("document", {
    querySelector: () => null,
    head: { appendChild: <T>(element: T) => element },
    createElement: () => ({ textContent: "" }),
  });
  const { readAloudPlayer } = await import("./readAloudPlayer");
  const active = () =>
    new Promise<void>((resolve) => {
      const unsubscribe = readAloudPlayer.subscribe(() => {
        if (readAloudPlayer.getSnapshot().status !== "active") return;
        unsubscribe();
        resolve();
      });
    });
  const prepared = async () => {
    const started = active();
    for (const segment of segments) mocks.onValue(segment);
    mocks.prepare.resolve({ _tag: "Success", value: undefined });
    await started;
    // Let the command's settlement land.
    await mocks.prepare.promise;
  };
  const startNarration = async (id = "message-1", rate: 1 | 1.5 = 1) => {
    mocks.prepare = deferred();
    readAloudPlayer.toggle(target(id), rate);
    await prepared();
  };
  return { readAloudPlayer, mediaSession, audioSession, fetch, prepared, startNarration };
}

describe("readAloudPlayer", () => {
  it("unlocks one audio element inside the tap and reuses it for every segment", async () => {
    const { readAloudPlayer, audioSession, fetch, prepared } = await setup();

    readAloudPlayer.toggle(target("message-1"), 1);
    expect(FakeAudio.log).toEqual(["new", "load"]);
    expect(audioSession.type).toBe("playback");

    await prepared();
    // The first segment plays without a second tap, on the unlocked element.
    expect(FakeAudio.log.slice(2)).toEqual([`src ${url(0)}`, "play"]);
    expect(fetch.mock.calls.map(([request]) => request)).toEqual([url(1), url(2)]);

    readAloudPlayer.next();
    readAloudPlayer.previous();
    expect(readAloudPlayer.getSnapshot()).toMatchObject({ index: 0, paused: false });
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it("advances on ended without a gesture and keeps the playback rate", async () => {
    const { readAloudPlayer, startNarration } = await setup();
    await startNarration("message-1", 1.5);
    const [audio] = FakeAudio.instances;
    audio!.ended = true;
    audio!.dispatchEvent(new Event("ended"));
    expect(readAloudPlayer.getSnapshot()).toMatchObject({ status: "active", index: 1 });
    expect(audio!.src).toBe(url(1));
    expect(audio!.playbackRate).toBe(1.5);
    expect(FakeAudio.log.at(-1)).toBe("play");
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it("reuses the element for the next narration", async () => {
    const { readAloudPlayer, startNarration } = await setup();
    await startNarration("message-1");
    await startNarration("message-2");
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.log.slice(-2)).toEqual([`src ${url(0)}`, "play"]);
    expect(readAloudPlayer.getSnapshot()).toMatchObject({
      status: "active",
      target: { source: { messageId: "message-2" } },
    });
  });

  it("mirrors a pause the system makes in the bar", async () => {
    const { readAloudPlayer, startNarration } = await setup();
    await startNarration();
    const [audio] = FakeAudio.instances;
    audio!.paused = true;
    audio!.dispatchEvent(new Event("pause"));
    expect(readAloudPlayer.getSnapshot()).toMatchObject({ paused: true });
  });

  it("drives the narration from the lock screen and clears it on stop", async () => {
    const { readAloudPlayer, mediaSession, startNarration } = await setup();
    await startNarration();
    expect(mediaSession.metadata).toMatchObject({ title: "Fix the flaky test", artist: "T3 Code" });
    expect(mediaSession.playbackState).toBe("playing");

    mediaSession.handlers.get("pause")?.();
    expect(readAloudPlayer.getSnapshot()).toMatchObject({ paused: true });
    expect(mediaSession.playbackState).toBe("paused");

    mediaSession.handlers.get("play")?.();
    mediaSession.handlers.get("nexttrack")?.();
    expect(readAloudPlayer.getSnapshot()).toMatchObject({ index: 1, paused: false });
    mediaSession.handlers.get("previoustrack")?.();
    expect(readAloudPlayer.getSnapshot()).toMatchObject({ index: 0 });

    mediaSession.handlers.get("stop")?.();
    expect(readAloudPlayer.getSnapshot()).toEqual({ status: "idle" });
    expect(mediaSession.metadata).toBeNull();
    expect(mediaSession.playbackState).toBe("none");
    expect([...mediaSession.handlers.values()].every((handler) => handler === null)).toBe(true);
  });

  it("plays segments as they arrive and waits at the end of what has arrived", async () => {
    const { readAloudPlayer } = await setup();
    const settled = deferred();
    mocks.prepare = settled;
    readAloudPlayer.toggle(target("message-1"), 1);
    expect(mocks.onValue(segments[0])).toBe(true);
    const [audio] = FakeAudio.instances;
    expect(audio!.src).toBe(url(0));
    expect(readAloudPlayer.getSnapshot()).toMatchObject({ segmentCount: 1, complete: false });

    audio!.ended = true;
    audio!.dispatchEvent(new Event("ended"));
    expect(readAloudPlayer.getSnapshot()).toMatchObject({
      status: "active",
      index: 1,
      buffering: true,
    });

    mocks.onValue(segments[1]);
    expect(audio!.src).toBe(url(1));
    expect(FakeAudio.log.at(-1)).toBe("play");

    const completed = new Promise<void>((resolve) => {
      const unsubscribe = readAloudPlayer.subscribe(() => {
        const state = readAloudPlayer.getSnapshot();
        if (state.status !== "active" || !state.complete) return;
        unsubscribe();
        resolve();
      });
    });
    settled.resolve({ _tag: "Success", value: undefined });
    await completed;
    expect(readAloudPlayer.getSnapshot()).toMatchObject({ segmentCount: 2, index: 1 });
    audio!.dispatchEvent(new Event("ended"));
    expect(readAloudPlayer.getSnapshot()).toEqual({ status: "idle" });
    // A stopped narration tells the stream to end.
    expect(mocks.onValue(segments[2])).toBe(false);
  });

  it("narrates a markdown file from the text on screen", async () => {
    const { readAloudPlayer, mediaSession, prepared } = await setup();
    readAloudPlayer.toggle(
      { environmentId, threadId, source: { kind: "document", path: "docs/user/guide.md" }, text },
      1,
    );
    await prepared();
    expect(mocks.prepareInputs).toEqual([{ path: "docs/user/guide.md", text }]);
    expect(readAloudPlayer.isTarget("document:docs/user/guide.md")).toBe(true);
    expect(mediaSession.metadata).toMatchObject({ title: "guide.md" });
  });
});
