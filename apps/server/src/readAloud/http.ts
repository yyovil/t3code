import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { assetFileResponse } from "../http.ts";
import { READ_ALOUD_AUDIO_MIME_TYPE } from "./elevenLabs.ts";
import * as ReadAloudService from "./ReadAloudService.ts";

const NO_STORE = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

/**
 * Audio elements cannot send auth headers, so the signed path is the grant,
 * as with `/api/assets`: minting one needs the operate scope over RPC.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* ReadAloudService.ReadAloudService;
    return HttpRouter.add("GET", `${ReadAloudService.READ_ALOUD_ROUTE_PREFIX}/*`, serve(service));
  }),
);

// Request instrumentation already owns the span.
const serve = Effect.fnUntraced(
  function* (service: ReadAloudService.ReadAloudService["Service"]) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const token = url.value.pathname
      .slice(`${ReadAloudService.READ_ALOUD_ROUTE_PREFIX}/`.length)
      .split("/")[0];
    if (!token) return HttpServerResponse.text("Not Found", { status: 404 });

    const audio = yield* service.audio(token);
    if (audio === null) return HttpServerResponse.text("Not Found", { status: 404 });
    if (audio.kind === "file") {
      return yield* assetFileResponse(
        { path: audio.path, mimeType: READ_ALOUD_AUDIO_MIME_TYPE },
        request.headers.range,
        request.headers["if-range"],
      );
    }
    return HttpServerResponse.stream(audio.stream, {
      contentType: READ_ALOUD_AUDIO_MIME_TYPE,
      headers: NO_STORE,
    });
  },
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        ReadAloudAudioError: (error) =>
          HttpServerResponse.json(
            { message: error.reason },
            { status: error.status, headers: NO_STORE },
          ),
        ReadAloudNotConfiguredError: (error) =>
          HttpServerResponse.json({ message: error.message }, { status: 409, headers: NO_STORE }),
      }),
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    ),
);
