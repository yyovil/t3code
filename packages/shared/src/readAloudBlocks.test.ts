import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";
import { rehypeReadAloudAnchors, splitReadAloudBlocks } from "./readAloudBlocks.ts";

const reply = [
  "# Upload retries",
  "Uploads now **retry** with backoff.",
  "- Doubles the wait\n- Stops after five tries\n  - nested detail stays in its item",
  "1. First\n2. Second",
  "```ts\nretry({ attempts: 5 });\n```",
  "> [!NOTE]\n> Only for idempotent requests.",
  "| Try | Wait |\n| --- | --- |\n| 1 | 1s |",
  "<details><summary>Logs</summary>\n\nraw output\n\n</details>",
  "<!-- hidden -->",
  "---",
  "Done.",
].join("\n\n");

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** The tree the chat view renders, as ChatMarkdown builds it. */
function renderedAnchors(text: string) {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS)
    .use(rehypeReadAloudAnchors);
  const tree = processor.runSync(processor.parse(text), text) as HastNode;
  const anchors: Array<[string, unknown]> = [];
  const visit = (node: HastNode) => {
    const offset = node.properties?.dataReadAloudOffset;
    if (offset !== undefined) anchors.push([node.tagName ?? "", offset]);
    node.children?.forEach(visit);
  };
  visit(tree);
  return anchors;
}

describe("splitReadAloudBlocks", () => {
  it("splits top-level blocks and list items, skipping what has nothing to say", () => {
    expect(splitReadAloudBlocks(reply).map((block) => [block.kind, block.source])).toEqual([
      ["heading", "# Upload retries"],
      ["paragraph", "Uploads now **retry** with backoff."],
      ["list-item", "- Doubles the wait"],
      ["list-item", "- Stops after five tries\n  - nested detail stays in its item"],
      ["list-item", "1. First"],
      ["list-item", "2. Second"],
      ["code", "```ts\nretry({ attempts: 5 });\n```"],
      ["quote", "> [!NOTE]\n> Only for idempotent requests."],
      ["table", "| Try | Wait |\n| --- | --- |\n| 1 | 1s |"],
      ["html", "<details><summary>Logs</summary>"],
      ["paragraph", "raw output"],
      ["paragraph", "Done."],
    ]);
  });

  it("finds each block's rendered element by the offset it starts at", () => {
    const blocks = splitReadAloudBlocks(reply);
    const anchors = renderedAnchors(reply);
    const anchored = new Map(anchors.map(([, offset]) => [offset, true]));
    // Raw HTML renders as one element; its inner paragraph highlights through it.
    const unanchored = blocks.filter((block) => !anchored.has(block.start));
    expect(unanchored.map((block) => block.source)).toEqual(["raw output"]);
    expect(anchors.map(([tag]) => tag)).toEqual([
      "h1",
      "p",
      "li",
      "li",
      "li",
      "li",
      "pre",
      "blockquote",
      "table",
      "details",
      "hr",
      "p",
    ]);
  });

  it("returns nothing for an empty message", () => {
    expect(splitReadAloudBlocks("  \n\n")).toEqual([]);
  });
});
