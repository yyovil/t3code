import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { decodeJsonReply } from "./textGenerationOperations.ts";
import { buildNarrationPrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildNarrationPrompt", () => {
  const input = {
    blocks: [
      { index: 0, kind: "paragraph", source: "Retries now back off." },
      { index: 1, kind: "code", source: "```ts\nretry({ attempts: 5 })\n```" },
    ],
    subject: {
      kind: "reply",
      threadTitle: "Flaky uploads",
      userPrompt: "why not retry?",
      previousExchange: { user: "Why do uploads fail?", assistant: "They time out." },
      changedFiles: ["src/upload.ts"],
    },
  } as const;

  it("gives the model every block by index, with the conversation around it", () => {
    const { prompt } = buildNarrationPrompt(input);
    expect(prompt).toContain('<block index="0" kind="paragraph">\nRetries now back off.\n</block>');
    expect(prompt).toContain('<block index="1" kind="code">');
    expect(prompt).toContain("<user_message>\nwhy not retry?\n</user_message>");
    expect(prompt).toContain("<previous_user_message>\nWhy do uploads fail?");
    expect(prompt).toContain("- src/upload.ts");
  });

  it("frames a document by its path instead of a conversation", () => {
    const { prompt } = buildNarrationPrompt({
      blocks: input.blocks,
      subject: { kind: "document", path: "docs/user/read-aloud.md" },
    });
    expect(prompt).toContain("markdown document");
    expect(prompt).toContain("<document_path>docs/user/read-aloud.md</document_path>");
    expect(prompt).toContain("The document to explain, as 2 blocks:");
    expect(prompt).not.toContain("<user_message>");
  });

  effectIt.effect("decodes segments from a reply wrapped in prose", () =>
    Effect.gen(function* () {
      const { outputSchema } = buildNarrationPrompt(input);
      const reply = `Here you go:\n${JSON.stringify({
        segments: [{ firstBlock: 0, lastBlock: 1, speech: "Uploads retry with a growing wait." }],
      })}`;
      const decoded = yield* decodeJsonReply(
        { operation: "generateNarration", outputSchema },
        "Test",
        reply,
      );
      expect(decoded.segments).toEqual([
        { firstBlock: 0, lastBlock: 1, speech: "Uploads retry with a growing wait." },
      ]);
    }),
  );

  effectIt.effect("rejects segments without speech", () =>
    Effect.gen(function* () {
      const { outputSchema } = buildNarrationPrompt(input);
      const error = yield* decodeJsonReply(
        { operation: "generateNarration", outputSchema },
        "Test",
        JSON.stringify({ segments: [{ firstBlock: 0, lastBlock: 1 }] }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TextGenerationError);
      expect(error.detail).toBe("Test returned invalid structured output.");
    }),
  );
});
