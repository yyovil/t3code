import * as Schema from "effect/Schema";

import { MessageId, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { TextGenerationError } from "./git.ts";

/** Playback rates the transport offers; the browser changes rate, so audio is cached once. */
export const READ_ALOUD_SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const;
export const ReadAloudSpeed = Schema.Literals(READ_ALOUD_SPEEDS);
export type ReadAloudSpeed = typeof ReadAloudSpeed.Type;

export const DEFAULT_READ_ALOUD_TTS_MODEL = "eleven_flash_v2_5";
// ElevenLabs' "George" premade voice, available on every account.
export const DEFAULT_READ_ALOUD_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

export const READ_ALOUD_TTS_MODELS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly description: string;
}> = [
  {
    id: "eleven_flash_v2_5",
    label: "Flash v2.5",
    description: "Fastest start and lowest cost.",
  },
  {
    id: "eleven_v4_turbo",
    label: "v4 Turbo",
    description: "Low latency with more natural delivery.",
  },
  {
    id: "eleven_multilingual_v2",
    label: "Multilingual v2",
    description: "Steady long-form narration; slower to start.",
  },
  { id: "eleven_v4", label: "v4", description: "Most expressive; slowest to start." },
];

/** Longer documents would not fit the narration prompt's budget. */
export const READ_ALOUD_DOCUMENT_MAX_CHARS = 60_000;

export const ReadAloudPrepareMessageInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});

/**
 * A markdown file as the client renders it. The client sends the text it shows
 * so the narration's blocks line up with what is on screen.
 */
export const ReadAloudPrepareDocumentInput = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(1_000)),
  text: Schema.String.check(Schema.isMaxLength(READ_ALOUD_DOCUMENT_MAX_CHARS)),
});

export const ReadAloudPrepareInput = Schema.Union([
  ReadAloudPrepareMessageInput,
  ReadAloudPrepareDocumentInput,
]);
export type ReadAloudPrepareInput = typeof ReadAloudPrepareInput.Type;

/**
 * One spoken stretch of a message. Blocks are the indices `splitReadAloudBlocks`
 * from `@t3tools/shared/readAloudBlocks` returns for the message text, inclusive.
 */
export const ReadAloudSegment = Schema.Struct({
  firstBlock: NonNegativeInt,
  lastBlock: NonNegativeInt,
  speech: Schema.String,
  /** Signed, relative to the environment's HTTP origin. Fetching it may spend TTS credits. */
  audioUrl: Schema.String,
});
export type ReadAloudSegment = typeof ReadAloudSegment.Type;

export const ReadAloudPrepareResult = Schema.Struct({
  segments: Schema.Array(ReadAloudSegment),
});
export type ReadAloudPrepareResult = typeof ReadAloudPrepareResult.Type;

export const ReadAloudVoice = Schema.Struct({
  voiceId: Schema.String,
  name: Schema.String,
  category: Schema.optional(Schema.String),
  /** ElevenLabs' public sample clip; playing it spends no credits. */
  previewUrl: Schema.optional(Schema.String),
});
export type ReadAloudVoice = typeof ReadAloudVoice.Type;

export const ReadAloudListVoicesResult = Schema.Struct({
  voices: Schema.Array(ReadAloudVoice),
});
export type ReadAloudListVoicesResult = typeof ReadAloudListVoicesResult.Type;

export class ReadAloudNotConfiguredError extends Schema.TaggedError<ReadAloudNotConfiguredError>()(
  "ReadAloudNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Add an ElevenLabs API key in Settings to read responses aloud.";
  }
}

export class ReadAloudMessageNotFoundError extends Schema.TaggedError<ReadAloudMessageNotFoundError>()(
  "ReadAloudMessageNotFoundError",
  { threadId: ThreadId, messageId: MessageId },
) {
  override get message(): string {
    return "This response is no longer available to read aloud.";
  }
}

export class ReadAloudVoicesError extends Schema.TaggedError<ReadAloudVoicesError>()(
  "ReadAloudVoicesError",
  {
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.status === undefined
      ? "Could not reach ElevenLabs to list voices."
      : `ElevenLabs could not list voices (HTTP ${this.status}).`;
  }
}

export class ReadAloudDocumentEmptyError extends Schema.TaggedError<ReadAloudDocumentEmptyError>()(
  "ReadAloudDocumentEmptyError",
  { path: Schema.String },
) {
  override get message(): string {
    return "This file has nothing to read aloud.";
  }
}

export const ReadAloudPrepareError = Schema.Union([
  ReadAloudNotConfiguredError,
  ReadAloudMessageNotFoundError,
  ReadAloudDocumentEmptyError,
  TextGenerationError,
]);
export type ReadAloudPrepareError = typeof ReadAloudPrepareError.Type;

export const ReadAloudListVoicesError = Schema.Union([
  ReadAloudNotConfiguredError,
  ReadAloudVoicesError,
]);
export type ReadAloudListVoicesError = typeof ReadAloudListVoicesError.Type;

/** Body of a failed audio response, so the client can say why playback stopped. */
export const ReadAloudAudioFailure = Schema.Struct({ message: Schema.String });
