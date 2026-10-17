import { Extension, type Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";

/** An editor state, or a transaction part-way through: whatever has a document and a selection. */
type Doc = Pick<EditorState, "doc" | "selection">;

import type { LineKind } from "@/lib/summary-edit";

/**
 * The formatted editor's line styles: text, two heading sizes, and dot points at an
 * exact depth. A dot point at level 2 means "two lists deep", whatever the line was
 * before — so a heading is turned into text, wrapped in a list, then moved in or out
 * until it sits at that depth.
 */

const LISTS = new Set(["bulletList", "orderedList"]);
const ITEM = "listItem";
/** More nesting than any summary has: a guard against a command that never settles. */
const MAX_MOVES = 12;

/** How many lists deep the selection starts, and whether the innermost one is numbered. */
export function listDepth(state: Doc): { depth: number; ordered: boolean } {
  const $from = state.selection.$from;
  let depth = 0;
  let innermost: string | null = null;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (LISTS.has(name)) {
      depth++;
      innermost ??= name;
    }
  }
  return { depth, ordered: innermost === "orderedList" };
}

/** The style of the line the cursor is on, or null when it is none of the toolbar's. */
export function activeKind(state: Doc): LineKind | null {
  const parent = state.selection.$from.parent;
  if (parent.type.name === "heading") {
    const level = parent.attrs.level as number;
    return level === 2 ? "h2" : level === 3 ? "h3" : null;
  }
  if (parent.type.name !== "paragraph") return null;
  const { depth, ordered } = listDepth(state);
  if (depth === 0) return "text";
  if (ordered || depth > 3) return null;
  return `bullet${depth}` as LineKind;
}

/**
 * The commands a style change is made of, all adding to one transaction. `tr` is read
 * for where things stand after each one: TipTap's own `state` inside a command only
 * catches up when its transaction is asked for.
 */
interface Steps {
  tr: Doc;
  commands: {
    liftListItem(name: string): boolean;
    sinkListItem(name: string): boolean;
    setParagraph(): boolean;
    setHeading(attrs: { level: 1 | 2 | 3 | 4 | 5 | 6 }): boolean;
    toggleBulletList(): boolean;
  };
}

function liftOutOfLists({ tr, commands }: Steps) {
  for (let i = 0; i < MAX_MOVES && listDepth(tr).depth > 0; i++) {
    if (!commands.liftListItem(ITEM)) break;
  }
}

/** Moves the selected dot points in or out until they are `level` lists deep (or can go no further). */
function moveToLevel({ tr, commands }: Steps, level: number) {
  for (let i = 0; i < MAX_MOVES; i++) {
    const { depth } = listDepth(tr);
    if (depth === level) return;
    // The first point of a list can't go deeper: there is nothing above it to sit under.
    const moved = depth < level ? commands.sinkListItem(ITEM) : commands.liftListItem(ITEM);
    if (!moved) return;
  }
}

/** Whether any line in the selection is something other than `name` (at `level`, for headings). */
function anyOtherThan(state: Doc, name: string, level?: number): boolean {
  const { from, to } = state.selection;
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock && (node.type.name !== name || (level !== undefined && node.attrs.level !== level))) found = true;
    return !found;
  });
  return found;
}

/**
 * TipTap's setParagraph and setHeading clear every wrapper — list, quote — off a line
 * that is already that kind, so they are only used on lines that need changing.
 */
function applyKind(steps: Steps, kind: LineKind): boolean {
  const { tr, commands } = steps;
  if (kind === "text") {
    liftOutOfLists(steps);
    if (anyOtherThan(tr, "paragraph")) commands.setParagraph();
  } else if (kind === "h2" || kind === "h3") {
    const level = kind === "h2" ? 2 : 3;
    liftOutOfLists(steps);
    if (anyOtherThan(tr, "heading", level)) commands.setHeading({ level });
  } else {
    // A list item holds lines of text, so a heading becomes one first.
    if (anyOtherThan(tr, "paragraph")) commands.setParagraph();
    const { depth, ordered } = listDepth(tr);
    // Wrapping in a list, or turning a numbered list into dot points.
    if ((depth === 0 || ordered) && !commands.toggleBulletList()) return false;
    moveToLevel(steps, Number(kind.slice(-1)));
  }
  return activeKind(tr) === kind;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    listLevels: {
      /** Turns the selected lines into one style, as a single step to undo. */
      setLineStyle: (kind: LineKind) => ReturnType;
    };
  }
}

/**
 * Turns the selected lines into one style. Returns whether the cursor's line now has it
 * (a dot point can't go deeper than the one above it, for one).
 */
export function setKind(editor: Editor, kind: LineKind): boolean {
  return editor.commands.setLineStyle(kind);
}

/**
 * Tab and Shift+Tab on a dot point: one level in or out. Out stops at the first level,
 * as in the Markdown view. Returns false off a list, so Tab keeps its usual meaning there
 * (the next table cell, say).
 */
export function shiftLevel(editor: Editor, direction: 1 | -1): boolean {
  const { depth } = listDepth(editor.state);
  if (depth === 0) return false;
  if (direction === 1) editor.commands.sinkListItem(ITEM);
  else if (depth > 1) editor.commands.liftListItem(ITEM);
  // Handled either way: Tab on a dot point never moves focus out of the summary.
  return true;
}

export const ListLevels = Extension.create({
  name: "listLevels",
  // Ahead of the list item's own Tab, which lets focus escape when a point can't move.
  priority: 1000,
  addCommands() {
    return {
      setLineStyle:
        (kind: LineKind) =>
        ({ tr, state, commands }) => {
          // List commands read the selection before the transaction; asking for the
          // transaction first brings the state they read up to date with earlier steps.
          const fresh =
            <A extends unknown[]>(run: (...args: A) => boolean) =>
            (...args: A) =>
              state.tr === tr && run(...args);
          return applyKind(
            {
              tr,
              commands: {
                liftListItem: fresh(commands.liftListItem),
                sinkListItem: fresh(commands.sinkListItem),
                setParagraph: fresh(commands.setParagraph),
                setHeading: fresh(commands.setHeading),
                toggleBulletList: fresh(commands.toggleBulletList),
              },
            },
            kind,
          );
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => shiftLevel(this.editor, 1),
      "Shift-Tab": () => shiftLevel(this.editor, -1),
    };
  },
});
