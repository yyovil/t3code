import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

/**
 * Read aloud explains an assistant message block by block. The server sends the
 * blocks to the narration model and the web client highlights them, so both
 * split with this one function. The client matches blocks to rendered elements
 * by source offset (see `rehypeReadAloudAnchors`), never by comparing text.
 */
export type ReadAloudBlockKind =
  | "paragraph"
  | "heading"
  | "list-item"
  | "code"
  | "table"
  | "quote"
  | "html"
  | "math"
  | "other";

export interface ReadAloudBlock {
  readonly kind: ReadAloudBlockKind;
  /** Source offsets into the message text, end exclusive. */
  readonly start: number;
  readonly end: number;
  readonly source: string;
}

// Line breaks and math only change inline rendering, never where blocks start.
const processor = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);

function blockKind(node: RootContent): ReadAloudBlockKind | null {
  switch (node.type) {
    case "paragraph":
      return "paragraph";
    case "heading":
      return "heading";
    case "code":
      return "code";
    case "table":
      return "table";
    case "blockquote":
      return "quote";
    case "html": {
      // A comment or a lone closing tag (the end of a raw `<details>`) has nothing to say.
      const value = node.value.trim();
      return value.startsWith("<!--") || /^<\/[a-z][\w-]*\s*>$/i.test(value) ? null : "html";
    }
    case "math":
      return "math";
    // Nothing to say, and nothing rendered where they stand.
    case "thematicBreak":
    case "definition":
    case "footnoteDefinition":
    case "yaml":
      return null;
    default:
      return "other";
  }
}

export function splitReadAloudBlocks(text: string): ReadonlyArray<ReadAloudBlock> {
  const tree = processor.runSync(processor.parse(text)) as Root;
  const blocks: ReadAloudBlock[] = [];
  const push = (kind: ReadAloudBlockKind, node: RootContent) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const source = text.slice(start, end);
    if (source.trim().length === 0) return;
    blocks.push({ kind, start, end, source });
  };
  for (const node of tree.children) {
    if (node.type === "list") {
      for (const item of node.children) push("list-item", item);
      continue;
    }
    const kind = blockKind(node);
    if (kind !== null) push(kind, node);
  }
  return blocks;
}

/** The attribute `rehypeReadAloudAnchors` writes, as it appears in the DOM. */
export const READ_ALOUD_OFFSET_ATTRIBUTE = "data-read-aloud-offset";

interface AnchorHastNode {
  type: string;
  tagName?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  position?: { start: { offset?: number | undefined } } | undefined;
  children?: AnchorHastNode[] | undefined;
}

function tagOffset(node: AnchorHastNode) {
  const offset = node.position?.start.offset;
  if (offset === undefined) return;
  node.properties = { ...node.properties, dataReadAloudOffset: offset };
}

/**
 * Tags each top-level rendered block, and each item of a top-level list, with
 * the source offset it starts at. Lists are not tagged themselves: a list and
 * its first item start at the same offset. Runs after sanitizing, which would
 * strip the attribute.
 */
export function rehypeReadAloudAnchors() {
  return (tree: AnchorHastNode) => {
    for (const child of tree.children ?? []) {
      if (child.type !== "element") continue;
      if (child.tagName === "ul" || child.tagName === "ol") {
        for (const item of child.children ?? []) {
          if (item.type === "element" && item.tagName === "li") tagOffset(item);
        }
        continue;
      }
      tagOffset(child);
    }
  };
}
