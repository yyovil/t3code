import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  RunId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import type { NarrationGenerationInput } from "@t3tools/provider-core/server/textGeneration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ReadAloudService from "./ReadAloudService.ts";

const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("assistant-1");
const runId = RunId.make("run-1");
const reply = "## Fix\n\nUploads retry now.\n\n- Backoff doubles\n- Gives up after five tries";

const projection = {
  thread: { title: "Flaky uploads", lineage: { parentThreadId: null } },
  visibleTurnItems: [
    { item: { type: "user_message", messageId: "user-1", text: "make uploads retry" } },
    {
      item: {
        type: "assistant_message",
        messageId,
        text: reply,
        runId,
        streaming: false,
      },
    },
  ],
  checkpoints: [],
};

const encoder = new TextEncoder();

interface Harness {
  readonly narrations: Array<NarrationGenerationInput>;
  readonly speechBodies: Array<string>;
  /** Holds the upstream audio body open until the test releases it. */
  readonly audioReleased: Promise<void>;
  readonly releaseAudio: () => void;
}

const makeLayer = (
  harness: Harness,
  options: {
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly speechStatus?: number;
    readonly narration?: ReadonlyArray<{ firstBlock: number; lastBlock: number; speech: string }>;
    /** Keeps the model writing, after it streamed its segments, until the test releases it. */
    readonly modelDone?: Deferred.Deferred<void>;
  } = {},
) =>
  ReadAloudService.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getThreadProjection: () => Effect.succeed(projection),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
    ),
    Layer.provide(
      Layer.succeed(TextGeneration.TextGeneration, {
        generateNarration: (input: NarrationGenerationInput) =>
          Effect.gen(function* () {
            harness.narrations.push(input);
            const segments = options.narration ?? [
              { firstBlock: 2, lastBlock: 2, speech: "The wait doubles each time." },
              { firstBlock: 3, lastBlock: 3, speech: "It gives up after five." },
            ];
            if (options.modelDone) {
              yield* Effect.forEach(segments, (draft) => input.onDraft?.(draft) ?? Effect.void);
              yield* Deferred.await(options.modelDone);
            }
            return { segments };
          }),
      } as unknown as TextGeneration.TextGeneration["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            harness.speechBodies.push(body);
            const status = options.speechStatus ?? 200;
            if (status !== 200) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ detail: { message: "Quota exceeded." } }, { status }),
              );
            }
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(encoder.encode("ID3-first-"));
                await harness.audioReleased;
                controller.enqueue(encoder.encode("second"));
                controller.close();
              },
            });
            return HttpClientResponse.fromWeb(
              request,
              new Response(stream, { headers: { "content-type": "audio/mpeg" } }),
            );
          }),
        ),
      ),
    ),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      ServerSettings.layerTest(
        options.settings ?? { readAloud: { elevenLabsApiKey: "xi-secret" } },
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-read-aloud-" })),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const makeHarness = Effect.sync((): Harness => {
  let releaseAudio = () => {};
  const audioReleased = new Promise<void>((resolve) => {
    releaseAudio = resolve;
  });
  return { narrations: [], speechBodies: [], audioReleased, releaseAudio };
});

const tokenOf = (audioUrl: string) => audioUrl.split("/")[3] ?? "";
const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) =>
      new TextDecoder().decode(Uint8Array.from([...chunks].flatMap((chunk) => [...chunk]))),
    ),
  );

describe("narrationCacheKey", () => {
  const base = {
    text: reply,
    voiceId: "voice-a",
    ttsModel: "eleven_flash_v2_5",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "haiku" },
  } satisfies Parameters<typeof ReadAloudService.narrationCacheKey>[0];

  it.effect("changes with anything the listener would hear differently", () =>
    Effect.gen(function* () {
      const key = yield* ReadAloudService.narrationCacheKey(base);
      expect(yield* ReadAloudService.narrationCacheKey({ ...base })).toBe(key);
      const variants = yield* Effect.forEach(
        [
          { ...base, text: `${reply}!` },
          { ...base, voiceId: "voice-b" },
          { ...base, ttsModel: "eleven_v4" },
          { ...base, documentPath: "docs/fix.md" },
          { ...base, modelSelection: { ...base.modelSelection, model: "sonnet" } },
          {
            ...base,
            modelSelection: {
              ...base.modelSelection,
              options: [{ id: "effort", value: "low" }],
            },
          },
        ],
        ReadAloudService.narrationCacheKey,
      );
      expect(new Set([key, ...variants]).size).toBe(variants.length + 1);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

const speeches = [
  "Fix",
  "Uploads retry now.",
  "The wait doubles each time.",
  "It gives up after five.",
];

const prepared = (input: Parameters<ReadAloudService.ReadAloudService["Service"]["prepare"]>[0]) =>
  ReadAloudService.ReadAloudService.use((service) =>
    Stream.runCollect(service.prepare(input)).pipe(Effect.map((segments) => [...segments])),
  );

describe("ReadAloudService", () => {
  it.effect("asks for an ElevenLabs key before spending anything", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const error = yield* prepared({ threadId, messageId }).pipe(
        Effect.flip,
        Effect.provide(makeLayer(harness, { settings: {} })),
      );
      expect(error._tag).toBe("ReadAloudNotConfiguredError");
      expect(harness.narrations).toEqual([]);
    }),
  );

  it.effect("reads the opening as written, narrates the rest once, and caches it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const first = yield* prepared({ threadId, messageId });
        const second = yield* prepared({ threadId, messageId });

        expect(harness.narrations).toHaveLength(1);
        const [narration] = harness.narrations;
        expect(narration?.subject).toMatchObject({
          kind: "reply",
          userPrompt: "make uploads retry",
          threadTitle: "Flaky uploads",
        });
        expect(narration?.blocks.map((block) => block.kind)).toEqual([
          "heading",
          "paragraph",
          "list-item",
          "list-item",
        ]);
        expect(narration?.spokenBlocks).toBe(2);
        expect(first.map(({ audioUrl: _url, ...segment }) => segment)).toEqual(
          speeches.map((speech, index) => ({ firstBlock: index, lastBlock: index, speech })),
        );
        expect(second.map((segment) => segment.speech)).toEqual(speeches);
        expect(first[0]?.audioUrl).toMatch(/^\/api\/read-aloud\/[\w-]+\.[\w-]+\/0\.mp3$/);
      }).pipe(Effect.provide(makeLayer(harness)));
    }),
  );

  it.effect("hands out segments and their audio while the model is still writing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const modelDone = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const service = yield* ReadAloudService.ReadAloudService;
        const early = yield* Stream.runCollect(
          service.prepare({ threadId, messageId }).pipe(Stream.take(3)),
        );
        // The last segment waits for the model: a gap after it could still extend it.
        expect([...early].map((segment) => segment.speech)).toEqual(speeches.slice(0, 3));

        const audio = yield* service.audio(tokenOf([...early][2]?.audioUrl ?? ""));
        expect(audio?.kind).toBe("stream");
        expect(harness.speechBodies[0]).toContain('"text":"The wait doubles each time."');

        yield* Deferred.succeed(modelDone, undefined);
        const all = yield* prepared({ threadId, messageId });
        expect(all.map((segment) => segment.speech)).toEqual(speeches);
        expect(harness.narrations).toHaveLength(1);
      }).pipe(Effect.provide(makeLayer(harness, { modelDone })));
    }),
  );

  it.effect("prepares the reply a finished run ended with, when turned on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const settings = { readAloud: { elevenLabsApiKey: "xi-secret", prepareInAdvance: true } };
      yield* Effect.gen(function* () {
        const service = yield* ReadAloudService.ReadAloudService;
        yield* service.prepareInAdvance({ threadId, runId: RunId.make("run-other") });
        expect(harness.narrations).toHaveLength(0);
        yield* service.prepareInAdvance({ threadId, runId });
        const segments = yield* prepared({ threadId, messageId });
        expect(segments.map((segment) => segment.speech)).toEqual(speeches);
        expect(harness.narrations).toHaveLength(1);
      }).pipe(Effect.provide(makeLayer(harness, { settings })));

      const off = yield* makeHarness;
      yield* ReadAloudService.ReadAloudService.use((service) =>
        service.prepareInAdvance({ threadId, runId }),
      ).pipe(Effect.provide(makeLayer(off)));
      expect(off.narrations).toHaveLength(0);
    }),
  );

  it.effect("narrates a markdown document from the text the client shows", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const path = "docs/uploads.md";
        const segments = yield* prepared({ path, text: reply });
        yield* prepared({ path, text: reply });
        // The same text as a reply is a different prompt, so it narrates again.
        yield* prepared({ threadId, messageId });

        expect(harness.narrations.map((narration) => narration.subject)).toEqual([
          { kind: "document", path },
          expect.objectContaining({ kind: "reply" }),
        ]);
        expect(segments.map((segment) => segment.speech)).toEqual(speeches);

        const error = yield* prepared({ path, text: "  \n" }).pipe(Effect.flip);
        expect(error._tag).toBe("ReadAloudDocumentEmptyError");
      }).pipe(Effect.provide(makeLayer(harness)));
    }),
  );

  it.effect("synthesizes a segment once for concurrent listeners and caches it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* ReadAloudService.ReadAloudService;
        const fs = yield* FileSystem.FileSystem;
        const segments = yield* prepared({ threadId, messageId });
        const token = tokenOf(segments[0]?.audioUrl ?? "");

        const [first, second] = yield* Effect.all([service.audio(token), service.audio(token)]);
        if (first?.kind !== "stream" || second?.kind !== "stream") {
          return expect.fail("expected live streams");
        }
        const reading = Effect.all([collect(first.stream), collect(second.stream)], {
          concurrency: "unbounded",
        });
        harness.releaseAudio();
        expect(yield* reading).toEqual(["ID3-first-second", "ID3-first-second"]);
        expect(harness.speechBodies).toHaveLength(1);
        expect(harness.speechBodies[0]).toContain('"next_text":"Uploads retry now."');

        const cached = yield* service.audio(token);
        if (cached?.kind !== "file") return expect.fail("expected the cached file");
        expect(yield* fs.readFileString(cached.path)).toBe("ID3-first-second");
        expect(harness.speechBodies).toHaveLength(1);
      }).pipe(Effect.provide(makeLayer(harness)));
    }),
  );

  it.effect("rejects forged audio links", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* ReadAloudService.ReadAloudService;
        const segments = yield* prepared({ threadId, messageId });
        const [payload] = tokenOf(segments[0]?.audioUrl ?? "").split(".");
        expect(yield* service.audio(`${payload}.forged`)).toBeNull();
        expect(yield* service.audio("garbage")).toBeNull();
        expect(harness.speechBodies).toEqual([]);
      }).pipe(Effect.provide(makeLayer(harness)));
    }),
  );

  it.effect("explains why ElevenLabs refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* ReadAloudService.ReadAloudService;
        const segments = yield* prepared({ threadId, messageId });
        const error = yield* service.audio(tokenOf(segments[1]?.audioUrl ?? "")).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ReadAloudAudioError",
          status: 502,
          reason: "ElevenLabs: Quota exceeded.",
        });
      }).pipe(Effect.provide(makeLayer(harness, { speechStatus: 402 })));
    }),
  );

  it.effect("fails when the model leaves the rest unsaid", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const layer = makeLayer(harness, {
        narration: [{ firstBlock: 2, lastBlock: 3, speech: " " }],
      });
      const error = yield* prepared({ threadId, messageId }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      expect(error).toBeInstanceOf(TextGenerationError);
    }),
  );
});
