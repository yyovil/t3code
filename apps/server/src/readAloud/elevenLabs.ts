import { ReadAloudVoicesError, type ReadAloudVoice } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io";
export const READ_ALOUD_AUDIO_MIME_TYPE = "audio/mpeg";
const OUTPUT_FORMAT = "mp3_44100_128";
const VOICE_PAGE_SIZE = 100;
const MAX_VOICE_PAGES = 5;

export interface SpeechRequest {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId: string;
  readonly text: string;
  /**
   * Text stitching keeps intonation continuous across segments. Request-id
   * stitching would too, but cached segments have no request id to pass.
   */
  readonly previousText?: string | undefined;
  readonly nextText?: string | undefined;
}

export function speechRequest(input: SpeechRequest): HttpClientRequest.HttpClientRequest {
  return HttpClientRequest.post(
    `${ELEVENLABS_API_ORIGIN}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/stream`,
  ).pipe(
    HttpClientRequest.setUrlParam("output_format", OUTPUT_FORMAT),
    HttpClientRequest.setHeader("xi-api-key", input.apiKey),
    HttpClientRequest.setHeader("accept", READ_ALOUD_AUDIO_MIME_TYPE),
    HttpClientRequest.bodyJsonUnsafe({
      text: input.text,
      model_id: input.modelId,
      ...(input.previousText ? { previous_text: input.previousText } : {}),
      ...(input.nextText ? { next_text: input.nextText } : {}),
    }),
  );
}

/** Starts synthesis; the response body streams audio as ElevenLabs produces it. */
export const synthesizeSpeech = Effect.fn("ElevenLabs.synthesizeSpeech")(function* (
  input: SpeechRequest,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(speechRequest(input));
});

const DetailMessage = Schema.Struct({ message: Schema.optional(Schema.String) });
const ValidationErrors = Schema.Array(Schema.Struct({ msg: Schema.optional(Schema.String) }));
const ErrorBody = Schema.Struct({
  detail: Schema.Union([Schema.String, DetailMessage, ValidationErrors]),
});
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));
const isValidationErrors = Schema.is(ValidationErrors);

function errorDetail(detail: typeof ErrorBody.Type.detail): string {
  if (typeof detail === "string") return detail;
  if (isValidationErrors(detail)) {
    return detail.flatMap((entry) => (entry.msg ? [entry.msg] : [])).join("; ");
  }
  return detail.message ?? "";
}

/** ElevenLabs' own explanation ("quota exceeded", "invalid voice"), bounded for a toast. */
export function speechFailureMessage(status: number, body: string): string {
  const detail = Option.match(decodeErrorBody(body), {
    onNone: () => "",
    onSome: (decoded) => errorDetail(decoded.detail),
  });
  const reason = detail.trim().slice(0, 300);
  if (status === 401) return reason || "ElevenLabs rejected the API key.";
  return reason ? `ElevenLabs: ${reason}` : `ElevenLabs failed with HTTP ${status}.`;
}

const VoicesPage = Schema.Struct({
  voices: Schema.Array(
    Schema.Struct({
      voice_id: Schema.String,
      name: Schema.optional(Schema.NullOr(Schema.String)),
      category: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  has_more: Schema.optional(Schema.Boolean),
  next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
});

export const listVoices = Effect.fn("ElevenLabs.listVoices")(function* (apiKey: string) {
  const client = yield* HttpClient.HttpClient;
  const voices: ReadAloudVoice[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_VOICE_PAGES; page++) {
    const request: HttpClientRequest.HttpClientRequest = HttpClientRequest.get(
      `${ELEVENLABS_API_ORIGIN}/v2/voices`,
    ).pipe(
      HttpClientRequest.setUrlParams({
        page_size: String(VOICE_PAGE_SIZE),
        ...(pageToken === null ? {} : { next_page_token: pageToken }),
      }),
      HttpClientRequest.setHeader("xi-api-key", apiKey),
    );
    const response: HttpClientResponse.HttpClientResponse = yield* client
      .execute(request)
      .pipe(Effect.mapError((cause) => new ReadAloudVoicesError({ cause })));
    if (response.status < 200 || response.status >= 300) {
      return yield* new ReadAloudVoicesError({ status: response.status });
    }
    const body: typeof VoicesPage.Type = yield* HttpClientResponse.schemaBodyJson(VoicesPage)(
      response,
    ).pipe(
      Effect.mapError((cause) => new ReadAloudVoicesError({ status: response.status, cause })),
    );
    for (const voice of body.voices) {
      voices.push({
        voiceId: voice.voice_id,
        name: voice.name?.trim() || voice.voice_id,
        ...(voice.category ? { category: voice.category } : {}),
      });
    }
    if (!body.has_more || !body.next_page_token) break;
    pageToken = body.next_page_token;
  }
  return voices;
});
