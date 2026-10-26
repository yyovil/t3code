import {
  ReadAloudDocumentEmptyError,
  ReadAloudMessageNotFoundError,
  ReadAloudNotConfiguredError,
  TextGenerationError,
  type ModelSelection,
  type ReadAloudListVoicesError,
  type ReadAloudListVoicesResult,
  type ReadAloudPrepareError,
  type ReadAloudPrepareInput,
  type ReadAloudSegment,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type { NarrationSegmentDraft } from "@t3tools/provider-core/server/textGeneration";
import { splitReadAloudBlocks, type ReadAloudBlock } from "@t3tools/shared/readAloudBlocks";
import { resolveReadAloudModelSelection } from "@t3tools/shared/serverSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ElevenLabs from "./elevenLabs.ts";
import {
  makeNarrationAssembler,
  narrationContext,
  verbatimOpening,
  type NarrationContext,
  type NarrationSegment,
} from "./narration.ts";

export const READ_ALOUD_ROUTE_PREFIX = "/api/read-aloud";
/** Bump when the narration prompt or block split changes, so cached narrations regenerate. */
const NARRATION_VERSION = 2;
const SIGNING_SECRET_NAME = "read-aloud-signing-key";
const AUDIO_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_BYTES = 300 * 1024 * 1024;
const STITCH_CONTEXT_CHARS = 300;

export class ReadAloudAudioError extends Schema.TaggedError<ReadAloudAudioError>()(
  "ReadAloudAudioError",
  {
    /** HTTP status for the client: the upstream's when ElevenLabs answered, else 502. */
    status: Schema.Number,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const NarrationRecord = Schema.Struct({
  voiceId: Schema.String,
  ttsModel: Schema.String,
  segments: Schema.Array(
    Schema.Struct({ firstBlock: Schema.Int, lastBlock: Schema.Int, speech: Schema.String }),
  ),
});
type NarrationRecord = typeof NarrationRecord.Type;
const decodeNarrationRecord = Schema.decodeUnknownOption(Schema.fromJsonString(NarrationRecord));
const encodeNarrationRecord = Schema.encodeSync(Schema.fromJsonString(NarrationRecord));

const AudioClaims = Schema.Struct({
  key: Schema.String,
  segment: Schema.Int,
  expiresAt: Schema.Number,
});
const decodeAudioClaims = Schema.decodeUnknownOption(Schema.fromJsonString(AudioClaims));
const encodeAudioClaims = Schema.encodeSync(Schema.fromJsonString(AudioClaims));
const encodeKeyParts = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Keyed on everything that changes what the listener hears. */
export const narrationCacheKey = Effect.fn("ReadAloudService.narrationCacheKey")(function* (input: {
  readonly text: string;
  /** Set for a markdown file: its path is part of the prompt. */
  readonly documentPath?: string | undefined;
  readonly voiceId: string;
  readonly ttsModel: string;
  readonly modelSelection: ModelSelection;
}) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(
      encodeKeyParts([
        NARRATION_VERSION,
        input.text,
        input.voiceId,
        input.ttsModel,
        input.modelSelection.instanceId,
        input.modelSelection.model,
        input.modelSelection.options ?? [],
        ...(input.documentPath === undefined ? [] : ["document", input.documentPath]),
      ]),
    ),
  );
  return Hex.encode(digest);
});

/** What ElevenLabs hears around a segment, so speech flows across the joins. */
function stitchContext(segments: ReadonlyArray<NarrationSegment>, index: number) {
  const previous = segments[index - 1]?.speech;
  const next = segments[index + 1]?.speech;
  return {
    ...(previous ? { previousText: previous.slice(-STITCH_CONTEXT_CHARS) } : {}),
    ...(next ? { nextText: next.slice(0, STITCH_CONTEXT_CHARS) } : {}),
  };
}

export type ReadAloudAudio =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stream"; readonly stream: Stream.Stream<Uint8Array, ReadAloudAudioError> };

/**
 * Output one producer appends and any number of readers replay from the
 * start, live. A reader that joins late misses nothing, and the producer keeps
 * going when every reader leaves, so the result still lands in the cache.
 */
interface Broadcast<A, E> {
  readonly items: Array<A>;
  state: "running" | "done" | { readonly error: E };
  wake: Deferred.Deferred<void>;
}

const makeBroadcast = <A, E>() =>
  Deferred.make<void>().pipe(
    Effect.map((wake): Broadcast<A, E> => ({ items: [], state: "running", wake })),
  );

// Runs once per audio chunk; the producer's span already covers it.
const notify = Effect.fnUntraced(function* <A, E>(broadcast: Broadcast<A, E>) {
  const wake = broadcast.wake;
  broadcast.wake = yield* Deferred.make<void>();
  yield* Deferred.succeed(wake, undefined);
});

const publish = <A, E>(broadcast: Broadcast<A, E>, item: A) =>
  Effect.suspend(() => {
    broadcast.items.push(item);
    return notify(broadcast);
  });

const settle = <A, E>(broadcast: Broadcast<A, E>, state: Broadcast<A, E>["state"]) =>
  Effect.suspend(() => {
    broadcast.state = state;
    return notify(broadcast);
  });

// Per-item reads of the buffer; the reader's own span already covers them.
const readBroadcast = <A, E>(broadcast: Broadcast<A, E>): Stream.Stream<A, E> =>
  Stream.paginate(
    0,
    (offset: number): Effect.Effect<readonly [ReadonlyArray<A>, Option.Option<number>], E> => {
      if (broadcast.items.length > offset) {
        return Effect.succeed([
          broadcast.items.slice(offset),
          Option.some(broadcast.items.length),
        ] as const);
      }
      const state = broadcast.state;
      if (state === "done") return Effect.succeed([[], Option.none<number>()] as const);
      if (state !== "running") return Effect.fail(state.error);
      return Deferred.await(broadcast.wake).pipe(Effect.as([[], Option.some(offset)] as const));
    },
  );

/** One synthesis per segment, however many requests ask for it: prefetch and playback share it. */
interface AudioJob extends Broadcast<Uint8Array, ReadAloudAudioError> {
  readonly started: Deferred.Deferred<void, ReadAloudAudioError>;
}

/**
 * One narration per message, whoever asks: a listener, a second tab, or the
 * preparation that runs when a reply finishes. Segments go out as they are
 * written, and the audio route reads them here until the narration is cached.
 */
interface NarrationJob extends Broadcast<NarrationSegment, TextGenerationError> {
  readonly voiceId: string;
  readonly ttsModel: string;
}

export class ReadAloudService extends Context.Service<
  ReadAloudService,
  {
    /** The narration's segments in order, each as soon as it exists. */
    readonly prepare: (
      input: ReadAloudPrepareInput,
    ) => Stream.Stream<ReadAloudSegment, ReadAloudPrepareError>;
    /**
     * Narrates the reply a finished run ended with, so pressing play later
     * starts at once. Does nothing unless the user turned it on.
     */
    readonly prepareInAdvance: (run: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<void>;
    readonly listVoices: Effect.Effect<ReadAloudListVoicesResult, ReadAloudListVoicesError>;
    /** Null when the token is forged, expired, or names a narration no longer cached. */
    readonly audio: (
      token: string,
    ) => Effect.Effect<ReadAloudAudio | null, ReadAloudAudioError | ReadAloudNotConfiguredError>;
  }
>()("t3/readAloud/ReadAloudService") {}

const make = Effect.fn("ReadAloudService.make")(function* (options?: {
  readonly cacheMaxBytes?: number;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const cacheDir = path.join(config.stateDir, "read-aloud");
  const cacheMaxBytes = options?.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES;
  const jobs = new Map<string, AudioJob>();
  const narrations = new Map<string, NarrationJob>();
  const jobScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(jobScope, Exit.void));

  const narrationPath = (key: string) => path.join(cacheDir, `${key}.json`);
  const audioPath = (key: string, segment: number) => path.join(cacheDir, `${key}-${segment}.mp3`);

  const signingSecret = secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);

  const apiKey = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.readAloud.elevenLabsApiKey),
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((key) =>
      key.length > 0 ? Effect.succeed(key) : Effect.fail(new ReadAloudNotConfiguredError()),
    ),
  );

  // A cache read that fails is a miss; a write that fails only costs a later regeneration.
  const touch = (filePath: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => fs.utimes(filePath, now / 1000, now / 1000)),
      Effect.ignore,
    );

  const evict = Effect.gen(function* () {
    const names = yield* fs.readDirectory(cacheDir);
    const entries = yield* Effect.forEach(names, (name) =>
      fs.stat(path.join(cacheDir, name)).pipe(
        Effect.map((info) => ({
          path: path.join(cacheDir, name),
          size: Number(info.size),
          mtime: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        })),
        Effect.option,
      ),
    );
    const files = entries.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= cacheMaxBytes) return;
    // Leave headroom so every write does not trigger another sweep.
    const target = cacheMaxBytes * 0.9;
    for (const file of files.toSorted((a, b) => a.mtime - b.mtime)) {
      if (total <= target) break;
      yield* fs.remove(file.path).pipe(Effect.ignore);
      total -= file.size;
    }
  }).pipe(Effect.ignore({ log: true }));

  const writeCacheFile = Effect.fn("ReadAloudService.writeCacheFile")(
    function* (filePath: string, bytes: Uint8Array) {
      yield* fs.makeDirectory(cacheDir, { recursive: true });
      const temporary = `${filePath}.${yield* crypto.randomUUIDv4()}.tmp`;
      yield* fs.writeFile(temporary, bytes);
      yield* fs
        .rename(temporary, filePath)
        .pipe(Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)));
      yield* evict;
    },
    Effect.ignore({ log: true }),
  );

  const readNarration = (key: string) =>
    fs.readFileString(narrationPath(key)).pipe(
      Effect.map(decodeNarrationRecord),
      Effect.orElseSucceed(() => Option.none<NarrationRecord>()),
      Effect.tap((record) => (Option.isSome(record) ? touch(narrationPath(key)) : Effect.void)),
    );

  const mintAudioUrl = Effect.fn("ReadAloudService.mintAudioUrl")(function* (
    key: string,
    segment: number,
    secret: Uint8Array,
  ) {
    const expiresAt = (yield* Clock.currentTimeMillis) + AUDIO_TOKEN_TTL_MS;
    const payload = base64UrlEncode(encodeAudioClaims({ key, segment, expiresAt }));
    return `${READ_ALOUD_ROUTE_PREFIX}/${payload}.${signPayload(payload, secret)}/${segment}.mp3`;
  });

  const resolveContext = Effect.fn("ReadAloudService.resolveContext")(function* (
    input: ReadAloudPrepareInput,
  ) {
    if ("path" in input) {
      yield* Effect.annotateCurrentSpan({ document: true });
      return {
        text: input.text,
        subject: { kind: "document", path: input.path },
      } satisfies NarrationContext;
    }
    yield* Effect.annotateCurrentSpan({ threadId: input.threadId });
    const projection = yield* projections
      .getThreadProjection(input.threadId)
      .pipe(Effect.mapError(() => new ReadAloudMessageNotFoundError(input)));
    const context = narrationContext(projection, input.messageId);
    if (!context) return yield* new ReadAloudMessageNotFoundError(input);
    return context;
  });

  const startNarration = Effect.fn("ReadAloudService.startNarration")(function* (request: {
    readonly key: string;
    readonly context: NarrationContext;
    readonly blocks: ReadonlyArray<ReadAloudBlock>;
    readonly voiceId: string;
    readonly ttsModel: string;
    readonly modelSelection: ModelSelection;
  }) {
    const existing = narrations.get(request.key);
    if (existing) return existing;
    const job: NarrationJob = {
      ...(yield* makeBroadcast<NarrationSegment, TextGenerationError>()),
      voiceId: request.voiceId,
      ttsModel: request.ttsModel,
    };
    narrations.set(request.key, job);
    const { blocks } = request;
    const run = Effect.gen(function* () {
      const opening = verbatimOpening(blocks);
      yield* Effect.forEach(opening, (segment) => publish(job, segment), { discard: true });
      if (opening.length < blocks.length) {
        const assembler = makeNarrationAssembler(blocks.length, opening.length);
        const take = (draft: NarrationSegmentDraft) => {
          const segment = assembler.push(draft);
          return segment ? publish(job, segment) : Effect.void;
        };
        let drafted = 0;
        yield* fs.makeDirectory(cacheDir, { recursive: true }).pipe(Effect.ignore);
        const generated = yield* textGeneration.generateNarration({
          // A neutral directory keeps repository instructions out of a prompt that needs none.
          cwd: cacheDir,
          blocks: blocks.map((block, index) => ({ index, kind: block.kind, source: block.source })),
          subject: request.context.subject,
          modelSelection: request.modelSelection,
          spokenBlocks: opening.length,
          onDraft: (draft) =>
            Effect.suspend(() => {
              drafted++;
              return take(draft);
            }),
        });
        yield* Effect.forEach(generated.segments.slice(drafted), take, { discard: true });
        // Without a last segment, the blocks after the opening would go unread.
        const last = assembler.finish();
        if (!last) {
          return yield* new TextGenerationError({
            operation: "generateNarration",
            detail: "The model returned no narration.",
          });
        }
        yield* publish(job, last);
      }
      yield* writeCacheFile(
        narrationPath(request.key),
        new TextEncoder().encode(
          encodeNarrationRecord({
            voiceId: request.voiceId,
            ttsModel: request.ttsModel,
            segments: job.items,
          }),
        ),
      );
      yield* settle(job, "done");
    }).pipe(
      Effect.catch((error: TextGenerationError) =>
        settle(job, { error }).pipe(
          Effect.andThen(Effect.logWarning("read aloud narration failed", { cause: error })),
        ),
      ),
      Effect.ensuring(Effect.sync(() => narrations.delete(request.key))),
      Effect.withSpan("ReadAloudService.generateNarration"),
    );
    yield* Effect.forkIn(run, jobScope);
    return job;
  });

  /** The cached narration, or the one being written: started here if nobody has yet. */
  const narrate = Effect.fn("ReadAloudService.narrate")(function* (
    context: NarrationContext,
    blocks: ReadonlyArray<ReadAloudBlock>,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const providers = yield* providerRegistry.getProviders;
    const modelSelection = resolveReadAloudModelSelection(settings, providers);
    const { voiceId, ttsModel } = settings.readAloud;
    const key = yield* narrationCacheKey({
      text: context.text,
      documentPath: context.subject.kind === "document" ? context.subject.path : undefined,
      voiceId,
      ttsModel,
      modelSelection,
    }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.orDie);
    const cached = yield* readNarration(key);
    const segments: Stream.Stream<NarrationSegment, TextGenerationError> = Option.isSome(cached)
      ? Stream.fromIterable(cached.value.segments)
      : readBroadcast(
          yield* startNarration({ key, context, blocks, voiceId, ttsModel, modelSelection }),
        );
    return { key, segments };
  });

  const prepareSegments = Effect.fn("ReadAloudService.prepare")(function* (
    input: ReadAloudPrepareInput,
  ) {
    yield* apiKey;
    const context = yield* resolveContext(input);
    const blocks = splitReadAloudBlocks(context.text);
    if (blocks.length === 0) {
      return yield* "path" in input
        ? new ReadAloudDocumentEmptyError({ path: input.path })
        : new ReadAloudMessageNotFoundError(input);
    }
    const secret = yield* signingSecret.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "generateNarration",
            detail: "Could not sign audio links.",
            cause,
          }),
      ),
    );
    const { key, segments } = yield* narrate(context, blocks);
    return segments.pipe(
      Stream.zipWithIndex,
      Stream.mapEffect(([segment, index]) =>
        mintAudioUrl(key, index, secret).pipe(Effect.map((audioUrl) => ({ ...segment, audioUrl }))),
      ),
    );
  });

  const prepare: ReadAloudService["Service"]["prepare"] = (input) =>
    Stream.unwrap(prepareSegments(input));

  const prepareInAdvance: ReadAloudService["Service"]["prepareInAdvance"] = Effect.fn(
    "ReadAloudService.prepareInAdvance",
  )(
    function* (run) {
      const settings = yield* serverSettings.getSettings;
      if (!settings.readAloud.prepareInAdvance || settings.readAloud.elevenLabsApiKey === "") {
        return;
      }
      const projection = yield* projections.getThreadProjection(run.threadId);
      // Subagent threads finish runs nobody reads; preparing them would spend tokens for nothing.
      if (projection.thread.lineage.parentThreadId !== null) return;
      const message = projection.visibleTurnItems.findLast(
        ({ item }) => item.type === "assistant_message" && item.runId === run.runId,
      )?.item;
      if (message?.type !== "assistant_message") return;
      const context = narrationContext(projection, message.messageId);
      if (!context) return;
      const blocks = splitReadAloudBlocks(context.text);
      if (blocks.length > 0) yield* narrate(context, blocks);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("preparing a narration in advance failed", { cause }),
    ),
  );

  const listVoices: ReadAloudService["Service"]["listVoices"] = Effect.gen(function* () {
    const key = yield* apiKey;
    const voices = yield* ElevenLabs.listVoices(key).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return { voices };
  }).pipe(Effect.withSpan("ReadAloudService.listVoices"));

  const verifyToken = Effect.fn("ReadAloudService.verifyToken")(function* (token: string) {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return Option.none();
    const secret = yield* signingSecret.pipe(Effect.option);
    if (Option.isNone(secret)) return Option.none();
    if (!timingSafeEqualBase64Url(signature, signPayload(payload, secret.value))) {
      return Option.none();
    }
    const claims = yield* Effect.try(() => decodeAudioClaims(base64UrlDecodeUtf8(payload))).pipe(
      Effect.orElseSucceed(() => Option.none<typeof AudioClaims.Type>()),
    );
    if (Option.isNone(claims)) return claims;
    const now = yield* Clock.currentTimeMillis;
    return claims.value.expiresAt > now ? claims : Option.none();
  });

  const startJob = Effect.fn("ReadAloudService.startJob")(function* (
    audioKey: string,
    filePath: string,
    request: ElevenLabs.SpeechRequest,
  ) {
    const existing = jobs.get(audioKey);
    if (existing) return existing;
    const job: AudioJob = {
      ...(yield* makeBroadcast<Uint8Array, ReadAloudAudioError>()),
      started: yield* Deferred.make<void, ReadAloudAudioError>(),
    };
    jobs.set(audioKey, job);
    const run = Effect.gen(function* () {
      const response = yield* ElevenLabs.synthesizeSpeech(request).pipe(
        Effect.mapError(
          (cause) =>
            new ReadAloudAudioError({
              status: 502,
              reason: "Could not reach ElevenLabs.",
              cause,
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* new ReadAloudAudioError({
          status: response.status === 401 || response.status === 429 ? response.status : 502,
          reason: ElevenLabs.speechFailureMessage(response.status, body),
        });
      }
      yield* Deferred.succeed(job.started, undefined);
      yield* response.stream.pipe(
        Stream.mapError(
          (cause) =>
            new ReadAloudAudioError({
              status: 502,
              reason: "ElevenLabs stopped sending audio.",
              cause,
            }),
        ),
        // Chunk-level bookkeeping under the synthesis span.
        Stream.runForEach((chunk) => publish(job, chunk)),
      );
      const size = job.items.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of job.items) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      yield* writeCacheFile(filePath, bytes);
      yield* settle(job, "done");
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.catch((error: ReadAloudAudioError) =>
        Effect.gen(function* () {
          yield* settle(job, { error });
          yield* Deferred.fail(job.started, error);
          yield* Effect.logWarning("read aloud synthesis failed", {
            status: error.status,
            cause: error.cause,
          });
        }),
      ),
      Effect.ensuring(Effect.sync(() => jobs.delete(audioKey))),
      Effect.withSpan("ReadAloudService.synthesize"),
    );
    yield* Effect.forkIn(run, jobScope);
    return job;
  });

  const audio: ReadAloudService["Service"]["audio"] = Effect.fn("ReadAloudService.audio")(
    function* (token) {
      const claims = yield* verifyToken(token);
      if (Option.isNone(claims)) return null;
      const { key, segment } = claims.value;
      const filePath = audioPath(key, segment);
      if (yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))) {
        yield* touch(filePath);
        return { kind: "file", path: filePath } as const;
      }
      // A narration still being written is not cached yet; its segments so far are enough.
      const writing = narrations.get(key);
      const record = writing
        ? Option.some({
            voiceId: writing.voiceId,
            ttsModel: writing.ttsModel,
            segments: writing.items,
          })
        : yield* readNarration(key);
      if (Option.isNone(record)) return null;
      const target = record.value.segments[segment];
      if (!target) return null;
      const job = yield* startJob(`${key}-${segment}`, filePath, {
        apiKey: yield* apiKey,
        voiceId: record.value.voiceId,
        modelId: record.value.ttsModel,
        text: target.speech,
        ...stitchContext(record.value.segments, segment),
      });
      yield* Deferred.await(job.started);
      return { kind: "stream", stream: readBroadcast(job) } as const;
    },
  );

  return ReadAloudService.of({ prepare, prepareInAdvance, listVoices, audio });
});

export const layer = Layer.effect(ReadAloudService, make());

/** Prepares narrations as runs finish, for users who turned that on. */
export const layerPrepareInAdvance = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* ReadAloudService;
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? service.prepareInAdvance({ threadId: event.threadId, runId: event.payload.id })
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("read aloud preparation event stream failed", { cause }),
        ),
      ),
    );
  }),
);
