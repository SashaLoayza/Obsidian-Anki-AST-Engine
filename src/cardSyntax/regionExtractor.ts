import type { RootContent, Text } from "mdast";
import type { Node, Parent } from "unist";
import { visit } from "unist-util-visit";
import { visitParents } from "unist-util-visit-parents";
import {
  createEmptyCardRegions,
  createSourceRange,
  type CardRegions,
  type DelimiterKind,
  type DelimiterRegion,
  type FieldRegion,
} from "./types";

const IGNORED_ANCESTOR_TYPES = new Set(["code", "inlineCode", "math"]);

export type MdastFieldRegion = {
  name: string;
  nodes: RootContent[];
};

export type ExtractedCardRegions = {
  textNodes: RootContent[];
  backNodes: RootContent[];
  fields: MdastFieldRegion[];
  regions: CardRegions;
  hasEmbeddedReversibleDelimiter: boolean;
  hasEmbeddedTypedDelimiter: boolean;
};

type DelimiterMatch = {
  index: number;
  length: number;
  kind: DelimiterKind;
  fieldName?: string;
};

type SplitAtDelimiterResult = {
  front?: RootContent;
  back?: RootContent;
  delimiter: DelimiterRegion;
};

export function extractCardRegions(bodyNodes: RootContent[], customDelimiter = ":::"): ExtractedCardRegions {
  const textNodes: RootContent[] = [];
  const backNodes: RootContent[] = [];
  const fields: MdastFieldRegion[] = [];
  const delimiters: DelimiterRegion[] = [];

  if (bodyNodes.length === 0) {
    return {
      textNodes,
      backNodes,
      fields,
      regions: createEmptyCardRegions(),
      hasEmbeddedReversibleDelimiter: false,
      hasEmbeddedTypedDelimiter: false,
    };
  }

  type Phase = "text" | "back" | "fields";
  let phase: Phase = "text";
  let currentField: MdastFieldRegion | null = null;

  for (const child of bodyNodes) {
    if (phase === "text") {
      const split = splitNodeAtFirstDelimiter(child, customDelimiter);
      if (!split) {
        textNodes.push(child);
        continue;
      }

      delimiters.push(split.delimiter);

      if (split.delimiter.kind === "field") {
        phase = "fields";
        if (split.front) {
          textNodes.push(split.front);
        }
        currentField = {
          name: split.delimiter.fieldName ?? "",
          nodes: split.back ? [split.back] : [],
        };
      } else {
        phase = "back";
        if (split.front) {
          textNodes.push(split.front);
        }
        if (split.back) {
          backNodes.push(split.back);
        }
      }
      continue;
    }

    if (phase === "back") {
      backNodes.push(child);
      continue;
    }

    const split = splitNodeAtFirstDelimiter(child, customDelimiter);
    if (split?.delimiter.kind === "field") {
      if (currentField) {
        fields.push(currentField);
      }
      delimiters.push(split.delimiter);
      currentField = {
        name: split.delimiter.fieldName ?? "",
        nodes: [],
      };
      if (split.front) {
        currentField.nodes.push(split.front);
      }
      if (split.back) {
        currentField.nodes.push(split.back);
      }
      continue;
    }

    if (currentField) {
      currentField.nodes.push(child);
    }
  }

  if (currentField) {
    fields.push(currentField);
  }

  const embedded = scanEmbeddedReservedDelimiters(bodyNodes);

  return {
    textNodes,
    backNodes,
    fields,
    regions: buildCardRegions(textNodes, backNodes, fields, delimiters),
    hasEmbeddedReversibleDelimiter: embedded.hasReversible,
    hasEmbeddedTypedDelimiter: embedded.hasTyped,
  };
}

function scanEmbeddedReservedDelimiters(bodyNodes: RootContent[]): {
  hasReversible: boolean;
  hasTyped: boolean;
} {
  let hasReversible = false;
  let hasTyped = false;

  for (const node of bodyNodes) {
    visit(node, (visited) => {
      if (visited.type !== "text" || !("value" in visited)) {
        return;
      }

      const value = String(visited.value);
      let searchFrom = 0;
      while (searchFrom < value.length) {
        const index = value.indexOf(":::", searchFrom);
        if (index === -1) {
          break;
        }

        const classified = classifyTripleColon(value, index);
        if (classified?.kind === ":::r") {
          hasReversible = true;
        }
        if (classified?.kind === ":::t") {
          hasTyped = true;
        }

        searchFrom = index + 3;
      }
    });
  }

  return { hasReversible, hasTyped };
}

function buildCardRegions(
  textNodes: RootContent[],
  backNodes: RootContent[],
  fields: MdastFieldRegion[],
  delimiters: DelimiterRegion[],
): CardRegions {
  const regions: CardRegions = { delimiters };

  const textRange = nodesRange(textNodes);
  if (textRange) {
    regions.text = textRange;
  }

  const backRange = nodesRange(backNodes);
  if (backRange) {
    regions.back = backRange;
  }

  if (fields.length > 0) {
    regions.fields = fields
      .map((field): FieldRegion | undefined => {
        const range = nodesRange(field.nodes);
        if (!range) {
          return undefined;
        }
        return { name: field.name, range };
      })
      .filter((field): field is FieldRegion => field !== undefined);
  }

  return regions;
}

function nodesRange(nodes: RootContent[]): ReturnType<typeof createSourceRange> | undefined {
  if (nodes.length === 0) {
    return undefined;
  }

  const first = nodes[0];
  const last = nodes[nodes.length - 1];

  if (first?.position?.start?.offset !== undefined && last?.position?.end?.offset !== undefined) {
    return createSourceRange(first.position.start.offset, last.position.end.offset);
  }

  let start: number | undefined;
  let end: number | undefined;

  for (const node of nodes) {
    visit(node, (visited) => {
      const position = visited.position;
      if (!position) {
        return;
      }

      const nodeStart = position.start?.offset;
      const nodeEnd = position.end?.offset;

      if (nodeStart !== undefined && (start === undefined || nodeStart < start)) {
        start = nodeStart;
      }
      if (nodeEnd !== undefined && (end === undefined || nodeEnd > end)) {
        end = nodeEnd;
      }
    });
  }

  if (start === undefined || end === undefined) {
    return undefined;
  }

  return createSourceRange(start, end);
}

function splitNodeAtFirstDelimiter(
  node: RootContent,
  customDelimiter = ":::",
): SplitAtDelimiterResult | null {
  let splitInfo:
    | {
        textNode: Text;
        match: DelimiterMatch;
      }
    | undefined;

  visitParents(node, (visited, ancestors) => {
    if (splitInfo) {
      return;
    }

    if (visited.type !== "text" || !("value" in visited)) {
      return;
    }

    if (isIgnoredContext(ancestors)) {
      return;
    }

    const value = String(visited.value);
    const match = findFirstDelimiterInText(value, customDelimiter);
    if (!match) {
      return;
    }

    splitInfo = {
      textNode: visited,
      match,
    };
  });

  if (!splitInfo) {
    return null;
  }

  const { textNode, match } = splitInfo;
  const frontText = textNode.value.slice(0, match.index).trimEnd();
  const backText = textNode.value
    .slice(match.index + match.length)
    .trimStart();

  const path = pathToNode(node as Parent, textNode);
  if (!path) {
    return null;
  }

  const frontClone = structuredClone(node);
  const backClone = structuredClone(node);
  pruneToSide(frontClone as unknown as Parent, path, frontText, "front");
  pruneToSide(backClone as unknown as Parent, path, backText, "back");

  const textStart = textNode.position?.start?.offset;
  const delimiter: DelimiterRegion = {
    kind: match.kind,
    range:
      textStart !== undefined
        ? createSourceRange(
            textStart + match.index,
            textStart + match.index + match.length,
          )
        : createSourceRange(0, match.length),
    ...(match.fieldName ? { fieldName: match.fieldName } : {}),
  };

  return {
    front: isEmptyNode(frontClone) ? undefined : frontClone,
    back: isEmptyNode(backClone) ? undefined : backClone,
    delimiter,
  };
}

function isIgnoredContext(ancestors: Node[]): boolean {
  return ancestors.some((ancestor) =>
    IGNORED_ANCESTOR_TYPES.has(ancestor.type),
  );
}

function isAtLineStart(value: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && value[cursor] === " ") {
    cursor -= 1;
  }
  if (cursor < 0) {
    return true;
  }
  return value[cursor] === "\n";
}

function isIdentifierContinuer(char: string | undefined): boolean {
  return char !== undefined && /[a-zA-Z0-9_]/.test(char);
}

function classifyTripleColon(
  value: string,
  index: number,
): DelimiterMatch | null {
  if (!value.startsWith(":::", index)) {
    return null;
  }

  const atLineStart = isAtLineStart(value, index);
  const after = value.slice(index + 3);

  if (!atLineStart) {
    return null;
  }

  if (after.startsWith("r") && !isIdentifierContinuer(after[1])) {
    return { index, length: 4, kind: ":::r" };
  }
  if (after.startsWith("t") && !isIdentifierContinuer(after[1])) {
    return { index, length: 4, kind: ":::t" };
  }
  if (after.startsWith(" ")) {
    const lineRemainder = after.slice(1);
    const newlineIndex = lineRemainder.indexOf("\n");
    const linePart =
      newlineIndex === -1
        ? lineRemainder
        : lineRemainder.slice(0, newlineIndex);
    const fieldName = linePart.trim();
    if (!fieldName) {
      return null;
    }
    return {
      index,
      length: 3 + 1 + linePart.length,
      kind: "field",
      fieldName,
    };
  }
  return { index, length: 3, kind: ":::" };
}

function findFirstDelimiterInText(
  value: string,
  customDelimiter = ":::",
): DelimiterMatch | null {
  let earliest: DelimiterMatch | null = null;
  let searchFrom = 0;

  while (searchFrom < value.length) {
    const index = value.indexOf(":::", searchFrom);
    if (index === -1) {
      break;
    }

    const classified = classifyTripleColon(value, index);
    if (classified && (!earliest || classified.index < earliest.index)) {
      earliest = classified;
    }

    searchFrom = index + 3;
  }

  if (customDelimiter !== ":::") {
    if (customDelimiter === "?") {
      const trimmed = value.trim();
      if (trimmed === "?") {
        const idx = value.indexOf("?");
        if (!earliest || idx < earliest.index) {
          earliest = { index: idx, length: 1, kind: ":::" };
        }
      } else {
        const inlineSplit = value.match(/\?(?=\s)/);
        if (inlineSplit?.index !== undefined) {
          if (!earliest || inlineSplit.index < earliest.index) {
            earliest = { index: inlineSplit.index, length: 1, kind: ":::" };
          }
        }
      }
    } else {
      let custSearch = 0;
      while (custSearch < value.length) {
        const idx = value.indexOf(customDelimiter, custSearch);
        if (idx === -1) break;
        if (isAtLineStart(value, idx)) {
          if (!earliest || idx < earliest.index) {
            earliest = { index: idx, length: customDelimiter.length, kind: ":::" };
          }
        }
        custSearch = idx + customDelimiter.length;
      }
    }
  }

  return earliest;
}

/** Index path from `root` down to `target`, e.g. [2] or [1, 0]. */
function pathToNode(root: Parent, target: Node): number[] | null {
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i] as RootContent;
    if (child === target) {
      return [i];
    }
    if ("children" in child) {
      const sub = pathToNode(child as Parent, target);
      if (sub) {
        return [i, ...sub];
      }
    }
  }
  return null;
}

/**
 * Keep only one side of the delimiter text node.
 * front: everything before it, plus `newText` in its place.
 * back:  `newText`, plus everything after it.
 * Applied at every level of the path, so nested containers are cut too.
 */
function pruneToSide(
  root: Parent,
  path: number[],
  newText: string,
  side: "front" | "back",
): void {
  let cur: Parent = root;

  for (let d = 0; d < path.length - 1; d++) {
    const i = path[d]!;
    cur.children = (
      side === "front" ? cur.children.slice(0, i + 1) : cur.children.slice(i)
    ) as typeof cur.children;
    cur = cur.children[side === "front" ? i : 0] as Parent;
  }

  const last = path[path.length - 1]!;
  const textNode = cur.children[last] as Text;
  const replacement = newText ? [{ ...textNode, value: newText }] : [];

  cur.children = (
    side === "front"
      ? [...cur.children.slice(0, last), ...replacement]
      : [...replacement, ...cur.children.slice(last + 1)]
  ) as typeof cur.children;
}

function isEmptyNode(node: RootContent): boolean {
  if (node.type === "text") {
    return node.value.trim().length === 0;
  }

  if (!("children" in node) || !Array.isArray(node.children)) {
    return false;
  }

  return node.children.length === 0;
}
