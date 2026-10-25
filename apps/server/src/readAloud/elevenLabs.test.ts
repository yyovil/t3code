import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { listVoices, speechFailureMessage, speechRequest } from "./elevenLabs.ts";

const json = Schema.fromJsonString(Schema.Unknown);
const parseJson = Schema.decodeUnknownSync(json);
const toJson = Schema.encodeSync(json);
const decodeBody = (request: ReturnType<typeof speechRequest>) =>
  request.body._tag === "Uint8Array"
    ? parseJson(new TextDecoder().decode(request.body.body))
    : undefined;

describe("speechRequest", () => {
  it("streams mp3 for the voice with the key, model, and stitching text", () => {
    const request = speechRequest({
      apiKey: "xi-secret",
      voiceId: "voice/1",
      modelId: "eleven_flash_v2_5",
      text: "The retry loop now backs off.",
      previousText: "Uploads were failing.",
      nextText: "Tests cover it.",
    });
    const url = new URL(request.url);
    expect(request.method).toBe("POST");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1/stream",
    );
    expect(request.urlParams.params).toContainEqual(["output_format", "mp3_44100_128"]);
    expect(request.headers["xi-api-key"]).toBe("xi-secret");
    expect(decodeBody(request)).toEqual({
      text: "The retry loop now backs off.",
      model_id: "eleven_flash_v2_5",
      previous_text: "Uploads were failing.",
      next_text: "Tests cover it.",
    });
  });

  it("leaves stitching out at the ends of a narration", () => {
    const body = decodeBody(
      speechRequest({ apiKey: "k", voiceId: "v", modelId: "m", text: "Only segment." }),
    );
    expect(body).toEqual({ text: "Only segment.", model_id: "m" });
  });
});

describe("speechFailureMessage", () => {
  it("passes on ElevenLabs' own reason", () => {
    const body = toJson({
      detail: { status: "quota_exceeded", message: "You have 12 credits remaining." },
    });
    expect(speechFailureMessage(402, body)).toBe("ElevenLabs: You have 12 credits remaining.");
    expect(speechFailureMessage(422, toJson({ detail: [{ msg: "bad voice" }] }))).toBe(
      "ElevenLabs: bad voice",
    );
  });

  it("falls back to the status", () => {
    expect(speechFailureMessage(500, "<html>")).toBe("ElevenLabs failed with HTTP 500.");
    expect(speechFailureMessage(401, "")).toBe("ElevenLabs rejected the API key.");
  });
});

describe("listVoices", () => {
  it.effect("follows pages and keeps the key on every request", () =>
    Effect.gen(function* () {
      const seen: Array<{ token: string | null; key: string | undefined }> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const param = request.urlParams.params.find(([name]) => name === "next_page_token")?.[1];
          const token = typeof param === "string" ? param : null;
          seen.push({ token, key: request.headers["xi-api-key"] });
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              token === null
                ? {
                    voices: [
                      {
                        voice_id: "a",
                        name: "Ada",
                        category: "premade",
                        preview_url: "https://cdn.test/ada.mp3",
                      },
                    ],
                    has_more: true,
                    next_page_token: "page-2",
                  }
                : { voices: [{ voice_id: "b", name: null }], has_more: false },
            ),
          );
        }),
      );
      const voices = yield* listVoices("xi-secret").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(voices).toEqual([
        { voiceId: "a", name: "Ada", category: "premade", previewUrl: "https://cdn.test/ada.mp3" },
        { voiceId: "b", name: "b" },
      ]);
      expect(seen).toEqual([
        { token: null, key: "xi-secret" },
        { token: "page-2", key: "xi-secret" },
      ]);
    }),
  );

  it.effect("reports the upstream status", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ detail: "no" }, { status: 401 })),
        ),
      );
      const error = yield* listVoices("bad").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(error.status).toBe(401);
    }),
  );
});
