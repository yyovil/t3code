import {
  ReadAloudMessageNotFoundError,
  ReadAloudNotConfiguredError,
  TextGenerationError,
  type ModelSelection,
  type ReadAloudListVoicesError,
  type ReadAloudListVoicesResult,
  type ReadAloudPrepareError,
  type ReadAloudPrepareInput,
  type ReadAloudPrepareResult,
} from "@t3tools/contracts";
import { splitReadAloudBlocks } from "@t3tools/shared/readAloudBlocks";
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
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ElevenLabs from "./elevenLabs.ts";
import { narrationContext, repairNarrationSegments, type NarrationSegment } from "./narration.ts";

export const READ_ALOUD_ROUTE_PREFIX = "/api/read-aloud";
/** Bump when the narration prompt or block split changes, so cached narrations regenerate. */
const NARRATION_VERSION = 1;
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
 * One synthesis per segment, however many requests ask for it. The browser's
 * prefetch and its playback request share the upstream stream, and audio keeps
 * downloading into the cache when a listener stops early.
 */
interface AudioJob {
  readonly started: Deferred.Deferred<void, ReadAloudAudioError>;
  readonly chunks: Array<Uint8Array>;
  state: "running" | "done" | ReadAloudAudioError;
  wake: Deferred.Deferred<void>;
}

export class ReadAloudService extends Context.Service<
  ReadAloudService,
  {
    readonly prepare: (
      input: ReadAloudPrepareInput,
    ) => Effect.Effect<ReadAloudPrepareResult, ReadAloudPrepareError>;
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

  const prepare: ReadAloudService["Service"]["prepare"] = Effect.fn("ReadAloudService.prepare")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({ threadId: input.threadId });
      yield* apiKey;
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const projection = yield* projections
        .getThreadProjection(input.threadId)
        .pipe(Effect.mapError(() => new ReadAloudMessageNotFoundError(input)));
      const context = narrationContext(projection, input.messageId);
      if (!context) return yield* new ReadAloudMessageNotFoundError(input);
      const blocks = splitReadAloudBlocks(context.text);
      if (blocks.length === 0) return yield* new ReadAloudMessageNotFoundError(input);

      const providers = yield* providerRegistry.getProviders;
      const modelSelection = resolveReadAloudModelSelection(settings, providers);
      const { voiceId, ttsModel } = settings.readAloud;
      const key = yield* narrationCacheKey({
        text: context.text,
        voiceId,
        ttsModel,
        modelSelection,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.orDie);

      const cached = yield* readNarration(key);
      const record: NarrationRecord = Option.isSome(cached)
        ? cached.value
        : yield* Effect.gen(function* () {
            yield* fs.makeDirectory(cacheDir, { recursive: true }).pipe(Effect.ignore);
            const generated = yield* textGeneration.generateNarration({
              // A neutral directory keeps repository instructions out of a prompt that needs none.
              cwd: cacheDir,
              blocks: blocks.map((block, index) => ({
                index,
                kind: block.kind,
                source: block.source,
              })),
              threadTitle: context.threadTitle,
              userPrompt: context.userPrompt,
              previousExchange: context.previousExchange,
              changedFiles: context.changedFiles,
              modelSelection,
            });
            const segments = repairNarrationSegments(blocks.length, generated.segments);
            if (segments.length === 0) {
              return yield* new TextGenerationError({
                operation: "generateNarration",
                detail: "The model returned no narration.",
              });
            }
            const fresh = { voiceId, ttsModel, segments };
            yield* writeCacheFile(
              narrationPath(key),
              new TextEncoder().encode(encodeNarrationRecord(fresh)),
            );
            return fresh;
          });

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
      const segments = yield* Effect.forEach(record.segments, (segment, index) =>
        mintAudioUrl(key, index, secret).pipe(Effect.map((audioUrl) => ({ ...segment, audioUrl }))),
      );
      return { segments };
    },
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

  // Per-chunk reads of the job buffer; the request span already covers them.
  const readJob = (job: AudioJob): Stream.Stream<Uint8Array, ReadAloudAudioError> =>
    Stream.paginate(
      0,
      (
        offset: number,
      ): Effect.Effect<
        readonly [ReadonlyArray<Uint8Array>, Option.Option<number>],
        ReadAloudAudioError
      > => {
        if (job.chunks.length > offset) {
          return Effect.succeed([
            job.chunks.slice(offset),
            Option.some(job.chunks.length),
          ] as const);
        }
        if (job.state === "done") return Effect.succeed([[], Option.none<number>()] as const);
        if (job.state !== "running") return Effect.fail(job.state);
        return Deferred.await(job.wake).pipe(Effect.as([[], Option.some(offset)] as const));
      },
    );

  const startJob = Effect.fn("ReadAloudService.startJob")(function* (
    audioKey: string,
    filePath: string,
    request: ElevenLabs.SpeechRequest,
  ) {
    {
      const existing = jobs.get(audioKey);
      if (existing) return existing;
      const job: AudioJob = {
        started: yield* Deferred.make<void, ReadAloudAudioError>(),
        chunks: [],
        state: "running",
        wake: yield* Deferred.make<void>(),
      };
      jobs.set(audioKey, job);
      const notify = Effect.gen(function* () {
        const wake = job.wake;
        job.wake = yield* Deferred.make<void>();
        yield* Deferred.succeed(wake, undefined);
      });
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
          Stream.runForEach((chunk) =>
            Effect.suspend(() => {
              job.chunks.push(chunk);
              return notify;
            }),
          ),
        );
        const size = job.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of job.chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        yield* writeCacheFile(filePath, bytes);
        job.state = "done";
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.catch((error: ReadAloudAudioError) =>
          Effect.gen(function* () {
            job.state = error;
            yield* Deferred.fail(job.started, error);
            yield* Effect.logWarning("read aloud synthesis failed", {
              status: error.status,
              cause: error.cause,
            });
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            jobs.delete(audioKey);
            return notify;
          }),
        ),
        Effect.withSpan("ReadAloudService.synthesize"),
      );
      yield* Effect.forkIn(run, jobScope);
      return job;
    }
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
      const record = yield* readNarration(key);
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
      return { kind: "stream", stream: readJob(job) } as const;
    },
  );

  return ReadAloudService.of({ prepare, listVoices, audio });
});

export const layer = Layer.effect(ReadAloudService, make());
