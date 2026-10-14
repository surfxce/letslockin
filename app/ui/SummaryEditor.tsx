"use client";

import "./summary-editor.css";
import "@/app/ui/desktop";

import type { JSONContent } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorProps } from "@tiptap/pm/view";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { saveSummaryEdit, type Placement } from "@/app/study-actions";
import { registerSummaryInserter } from "@/app/ui/ask";
import { Icon } from "@/app/ui/Icon";
import type { SlideImages } from "@/lib/markdown";
import { insertAtStart, insertIntoSection, insertUnder, setLineKind, shiftLines, type LineKind } from "@/lib/summary-edit";

import { activeKind, listDepth, setKind } from "./editor/blocks";
import { clearDraft, readDraft, sameSummary, writeDraft, type SummaryDraft } from "./editor/drafts";
import { lostWords, summaryCodec, summaryExtensions } from "./editor/markdown";
import { continueList, lineKindAt, looksLikeMarkdown, relativeTime, toggleMark } from "./editor/text";

/**
 * Editing a lecture's summary in place, two ways the student can swap between at any
 * time: formatted, which looks like the summary as it is read, and its Markdown. Both
 * have the same line styles — text, headings, dot points at three levels — and both
 * keep the slide pictures exactly as written.
 *
 * Nothing typed is lost: edits are kept in this browser as they are typed, offered back
 * if the page is left unsaved, and a save never overwrites a summary that changed
 * underneath it (an answer added from another window) without asking.
 */

type View = "formatted" | "markdown";

const VIEW_KEY = "lockin.summaryEditor.view";
const KEEP_AFTER_MS = 800;
/** Marks a transaction that only reloads the editor, so it doesn't count as an edit. */
const LOAD = "lockinLoad";

const KINDS: Array<{ kind: LineKind; label: string; title: string }> = [
  { kind: "text", label: "Text", title: "Plain text" },
  { kind: "h2", label: "Heading", title: "Heading" },
  { kind: "h3", label: "Subheading", title: "Subheading" },
  { kind: "bullet1", label: "• Point", title: "Dot point" },
  { kind: "bullet2", label: "◦ Sub-point", title: "Dot point, one level in (Tab moves a point in, Shift+Tab out)" },
  { kind: "bullet3", label: "▪ Sub-sub-point", title: "Dot point, two levels in" },
];

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "markdown" ? "markdown" : "formatted";
  } catch {
    return "formatted";
  }
}

function rememberView(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Not remembered: the editor opens formatted next time.
  }
}

/** Where a block from the Ask panel goes in the summary. */
function place(md: string, block: string, where: Placement): string {
  if ("under" in where) return insertUnder(md, where.under, block);
  if ("start" in where) return insertAtStart(md, block);
  return insertIntoSection(md, where.section, block);
}

/** How the editor opens: formatted unless the student last used Markdown, or formatting it would lose words. */
function opening(markdown: string): { view: View; lost: string[] | null; doc: JSONContent | null } {
  if (readView() === "markdown") return { view: "markdown", lost: null, doc: null };
  const codec = summaryCodec();
  const doc = codec.parse(markdown);
  const lost = lostWords(markdown, codec.serialize(doc));
  return lost.length ? { view: "markdown", lost, doc: null } : { view: "formatted", lost: null, doc };
}

interface Offer {
  draft: SummaryDraft;
  /** The summary has changed since the draft was started. */
  stale: boolean;
  when: string;
}

function findOffer(lectureId: string, markdown: string): Offer | null {
  const draft = readDraft(lectureId);
  if (!draft || sameSummary(draft.markdown, markdown)) return null;
  return { draft, stale: !sameSummary(draft.base, markdown), when: relativeTime(draft.at) };
}

const fieldSizing = () => typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");

export function SummaryEditor({
  lectureId,
  markdown,
  slides,
  onDone,
}: {
  lectureId: string;
  markdown: string;
  slides: SlideImages;
  /** Called when editing ends: true when the summary was saved. */
  onDone: (saved: boolean) => void;
}) {
  // The summary as it was when editing began: what a save checks hasn't changed since.
  const [base] = useState(markdown);
  const [start] = useState(() => opening(markdown));
  const [view, setView] = useState<View>(start.view);
  const [text, setText] = useState(markdown);
  const [changed, setChanged] = useState(false);
  const [kept, setKept] = useState(false);
  const [offer, setOffer] = useState<Offer | null>(() => findOffer(lectureId, markdown));
  const [lost, setLost] = useState<string[] | null>(start.lost);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [mdKind, setMdKind] = useState<LineKind | null>(() => lineKindAt(markdown, 0));

  const viewRef = useRef<View>(start.view);
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** The Markdown view's text, for callbacks that outlive a render. */
  const textValue = useRef(markdown);
  const editorRef = useRef<Editor | null>(null);
  /** The Markdown the formatted editor holds (null before it holds any), and whether it has been edited since. */
  const loaded = useRef<string | null>(start.doc ? markdown : null);
  const edited = useRef(false);
  /** Markdown waiting for the formatted editor to exist. */
  const pending = useRef<string | null>(null);
  const changedRef = useRef(false);
  const offerRef = useRef(offer !== null);
  /** Saved, cancelled or discarded: nothing more is kept as a draft. */
  const closed = useRef(false);
  const timer = useRef<number | null>(null);
  const selectAfter = useRef<[number, number] | null>(null);
  const savingRef = useRef(false);
  const router = useRouter();
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // ---------------------------------------------------------------------------
  // The summary as it stands, whichever view is open.

  const current = useCallback((): string => {
    if (viewRef.current === "markdown") return textValue.current;
    const ed = editorRef.current;
    if (edited.current && ed && !ed.isDestroyed) return summaryCodec().serialize(ed.getJSON());
    return loaded.current ?? textValue.current;
  }, []);

  /** Keeps the edits in this browser, or forgets the draft when there are none. */
  const keep = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (closed.current) return;
    const md = current();
    if (sameSummary(md, base)) {
      changedRef.current = false;
      setChanged(false);
      setKept(false);
      // A draft from an earlier visit stays until the student says what to do with it.
      if (!offerRef.current) clearDraft(lectureId);
      return;
    }
    setKept(writeDraft(lectureId, { markdown: md, base, at: Date.now() }));
  }, [base, current, lectureId]);

  const markChanged = useCallback(() => {
    changedRef.current = true;
    setChanged(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(keep, KEEP_AFTER_MS);
  }, [keep]);

  const markChangedRef = useRef(markChanged);
  useEffect(() => {
    markChangedRef.current = markChanged;
  }, [markChanged]);

  // ---------------------------------------------------------------------------
  // The formatted editor.

  const [extensions] = useState(() => summaryExtensions(slides));
  const [editorProps] = useState<EditorProps>(() => ({
    attributes: { class: "prose ed-surface", "aria-label": "Summary", spellcheck: "true" },
    // Markdown pasted from an AI chat or a text file arrives formatted.
    handlePaste: (_view, event) => {
      const data = event.clipboardData;
      const plain = data?.getData("text/plain") ?? "";
      if (!plain || data?.getData("text/html") || !looksLikeMarkdown(plain)) return false;
      const ed = editorRef.current;
      if (!ed) return false;
      return ed.commands.insertContent(summaryCodec().parse(plain).content ?? []);
    },
    // Copying gives Markdown, so it pastes into the Markdown view (or an AI chat) intact.
    clipboardTextSerializer: (slice) => {
      try {
        return summaryCodec().serialize({ type: "doc", content: slice.content.toJSON() ?? [] }).trim();
      } catch {
        return slice.content.textBetween(0, slice.content.size, "\n\n");
      }
    },
  }));

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    editorProps,
    content: start.doc ?? undefined,
    onUpdate: ({ transaction }) => {
      // Only edits count: not a reload, and not the empty line the editor adds at the end.
      if (!transaction.docChanged || transaction.getMeta(LOAD)) return;
      edited.current = true;
      markChangedRef.current();
    },
  });

  const toolbar = useEditorState({
    editor,
    selector: ({ editor: ed }) =>
      ed ? { kind: activeKind(ed.state), bold: ed.isActive("bold"), italic: ed.isActive("italic") } : null,
  });

  /** Puts Markdown in the formatted editor as a fresh start, with nothing to undo back past. */
  const loadEditor = useCallback((md: string) => {
    const ed = editorRef.current;
    loaded.current = md;
    edited.current = false;
    if (!ed || ed.isDestroyed) {
      pending.current = md;
      return;
    }
    const doc = ed.schema.nodeFromJSON(summaryCodec().parse(md));
    ed.view.updateState(EditorState.create({ doc, plugins: ed.state.plugins, selection: TextSelection.atStart(doc) }));
    // Tells the toolbar the document is new.
    ed.view.dispatch(ed.state.tr.setMeta(LOAD, true).setMeta("addToHistory", false));
  }, []);

  useEffect(() => {
    editorRef.current = editor;
    if (!editor) return;
    if (pending.current !== null) {
      const md = pending.current;
      pending.current = null;
      loadEditor(md);
    }
    if (viewRef.current === "formatted") editor.commands.focus("start", { scrollIntoView: false });
  }, [editor, loadEditor]);

  // Opening as Markdown: the cursor goes in it, as it would in the formatted view.
  useEffect(() => {
    if (start.view === "markdown") textRef.current?.focus({ preventScroll: true });
  }, [start.view]);

  // ---------------------------------------------------------------------------
  // The Markdown view.

  /**
   * Changes the Markdown view's text through the browser, so Ctrl+Z undoes a toolbar
   * change like any typing — falling back to setting it when the browser won't.
   */
  const applyText = useCallback(
    (next: { text: string; start: number; end: number }) => {
      const ta = textRef.current;
      if (!ta) return;
      ta.focus({ preventScroll: true });
      const old = ta.value;
      if (old !== next.text) {
        let a = 0;
        while (a < old.length && a < next.text.length && old[a] === next.text[a]) a++;
        let b = 0;
        while (b < old.length - a && b < next.text.length - a && old[old.length - 1 - b] === next.text[next.text.length - 1 - b]) b++;
        const insert = next.text.slice(a, next.text.length - b);
        ta.setSelectionRange(a, old.length - b);
        let done = false;
        try {
          done = document.execCommand(insert ? "insertText" : "delete", false, insert);
        } catch {
          done = false;
        }
        if (!done || ta.value !== next.text) {
          textValue.current = next.text;
          setText(next.text);
          selectAfter.current = [next.start, next.end];
          markChanged();
          return;
        }
      }
      ta.setSelectionRange(next.start, next.end);
      setMdKind(lineKindAt(next.text, next.start));
    },
    [markChanged],
  );

  // A selection set before React put the new text in place.
  useLayoutEffect(() => {
    const ta = textRef.current;
    const sel = selectAfter.current;
    if (!ta || !sel) return;
    selectAfter.current = null;
    ta.setSelectionRange(sel[0], sel[1]);
  }, [text]);

  // Grows with its text where the browser can't do that by itself.
  useLayoutEffect(() => {
    const ta = textRef.current;
    if (!ta || view !== "markdown" || fieldSizing()) return;
    const y = window.scrollY;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
    window.scrollTo({ top: y });
  }, [text, view]);

  /** The Markdown view's toolbar follows the line the cursor is on. */
  function trackKind(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    setMdKind(lineKindAt(e.currentTarget.value, e.currentTarget.selectionStart));
  }

  function onTextKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    const mod = e.metaKey || e.ctrlKey;
    const { selectionStart: s, selectionEnd: t, value } = ta;
    if (e.key === "Tab" && !mod && !e.altKey) {
      // Dot points in and out; never focus out of the summary.
      e.preventDefault();
      applyText(shiftLines(value, s, t, e.shiftKey ? -1 : 1));
    } else if (mod && !e.altKey && !e.shiftKey && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      applyText(toggleMark(value, s, t, "**"));
    } else if (mod && !e.altKey && !e.shiftKey && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      applyText(toggleMark(value, s, t, "*"));
    } else if (e.key === "Enter" && !mod && !e.altKey && !e.shiftKey && !e.nativeEvent.isComposing) {
      const next = continueList(value, s, t);
      if (next) {
        e.preventDefault();
        applyText(next);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Switching views.

  const focusView = useCallback((to: View) => {
    requestAnimationFrame(() => {
      if (to === "markdown") textRef.current?.focus({ preventScroll: true });
      else editorRef.current?.commands.focus(null, { scrollIntoView: false });
    });
  }, []);

  const showView = useCallback(
    (to: View) => {
      viewRef.current = to;
      setView(to);
      rememberView(to);
      focusView(to);
    },
    [focusView],
  );

  /** To formatted — unless that would lose words, when the student is asked first. */
  const toFormatted = useCallback(
    (anyway = false) => {
      const md = textValue.current;
      // Back from Markdown without changes: the editor already holds it, undo history and all.
      if (md === loaded.current && !edited.current && editorRef.current && !pending.current) {
        setLost(null);
        showView("formatted");
        return;
      }
      if (!anyway) {
        const gone = lostWords(md, summaryCodec().roundTrip(md));
        if (gone.length) {
          setLost(gone);
          return;
        }
      }
      setLost(null);
      loadEditor(md);
      showView("formatted");
    },
    [loadEditor, showView],
  );

  const toMarkdown = useCallback(() => {
    const md = current();
    // Edits made formatted are now the Markdown the editor holds.
    loaded.current = md;
    edited.current = false;
    textValue.current = md;
    setText(md);
    setMdKind(lineKindAt(md, 0));
    showView("markdown");
  }, [current, showView]);

  /** Puts a whole new version of the summary in whichever view is open. */
  const replaceWith = useCallback(
    (md: string, undoable: boolean) => {
      if (viewRef.current === "formatted") {
        const gone = lostWords(md, summaryCodec().roundTrip(md));
        if (gone.length === 0) {
          const ed = editorRef.current;
          if (undoable && ed && !ed.isDestroyed) {
            const y = window.scrollY;
            ed.commands.setContent(summaryCodec().parse(md));
            window.scrollTo({ top: y });
          } else {
            loadEditor(md);
          }
          // Counted as an edit even when it reads the same as before.
          loaded.current = md;
          edited.current = undoable;
          markChanged();
          return;
        }
        // It can only be kept exactly as Markdown.
        setLost(gone);
        viewRef.current = "markdown";
        setView("markdown");
      }
      textValue.current = md;
      setText(md);
      setMdKind(lineKindAt(md, 0));
      markChanged();
    },
    [loadEditor, markChanged],
  );

  // ---------------------------------------------------------------------------
  // The toolbar.

  function chooseKind(kind: LineKind) {
    setNote(null);
    if (viewRef.current === "formatted") {
      const ed = editorRef.current;
      if (!ed) return;
      ed.commands.focus(null, { scrollIntoView: false });
      // A point that couldn't go as deep as asked: say why, rather than seem to ignore the click.
      if (!setKind(ed, kind) && kind.startsWith("bullet") && listDepth(ed.state).depth > 0) {
        setNote("A dot point can only go one level deeper than the point above it.");
      }
      return;
    }
    const ta = textRef.current;
    if (ta) applyText(setLineKind(ta.value, ta.selectionStart, ta.selectionEnd, kind));
  }

  function chooseMark(marker: "**" | "*") {
    if (viewRef.current === "formatted") {
      const chain = editorRef.current?.chain().focus(null, { scrollIntoView: false });
      if (marker === "**") chain?.toggleBold().run();
      else chain?.toggleItalic().run();
      return;
    }
    const ta = textRef.current;
    if (ta) applyText(toggleMark(ta.value, ta.selectionStart, ta.selectionEnd, marker));
  }

  // ---------------------------------------------------------------------------
  // Saving, cancelling, and drafts from before.

  const close = useCallback(
    (saved: boolean) => {
      closed.current = true;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      onDoneRef.current(saved);
    },
    [],
  );

  const save = useCallback(
    async (force = false) => {
      if (savingRef.current) return;
      const md = current();
      if (!force && sameSummary(md, base)) {
        // Nothing to save. A draft from before that wasn't answered about is left for next time.
        if (!offerRef.current) clearDraft(lectureId);
        close(false);
        return;
      }
      // Kept first, in case the save itself fails.
      keep();
      savingRef.current = true;
      setSaving(true);
      setError(null);
      setConflict(null);
      try {
        const res = await saveSummaryEdit({ lectureId, markdown: md, base, force });
        if (res.ok) {
          clearDraft(lectureId);
          close(true);
          return;
        }
        if (res.conflict) setConflict(res.message);
        else setError(res.message);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [base, close, current, keep, lectureId],
  );

  function cancel() {
    const unsaved = !sameSummary(current(), base);
    if (unsaved && !window.confirm("Discard your changes to this summary?")) return;
    // An earlier draft the student hasn't answered about yet is left for next time.
    if (unsaved || !offerRef.current) clearDraft(lectureId);
    close(false);
  }

  /** After a conflict: the edits go, and the page fetches the summary that changed. */
  function discardMine() {
    clearDraft(lectureId);
    close(false);
    router.refresh();
  }

  function restore() {
    if (!offer) return;
    offerRef.current = false;
    setOffer(null);
    replaceWith(offer.draft.markdown, false);
    focusView(viewRef.current);
  }

  function dismissOffer() {
    offerRef.current = false;
    setOffer(null);
    // Edits made since opening are the draft now; keep those.
    if (!changedRef.current) clearDraft(lectureId);
    focusView(viewRef.current);
  }

  // ---------------------------------------------------------------------------
  // While open.

  // The header's background refresh would re-render the page under the editor.
  useEffect(() => {
    window.__lockinHoldRefresh = true;
    return () => {
      window.__lockinHoldRefresh = false;
    };
  }, []);

  // An answer added from the Ask panel lands here, in the edit, not under it on the server.
  useEffect(
    () =>
      registerSummaryInserter((block, where) => {
        replaceWith(place(current(), block, where), true);
        setNote("Added — save the summary to keep it.");
      }),
    [current, replaceWith],
  );

  // Ctrl+S / Cmd+S saves, wherever focus is.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving: keep what's typed at once, and ask in a browser tab. (The desktop app can't
  // show that question, and would just refuse to close; the draft is kept either way.)
  const keepRef = useRef(keep);
  useEffect(() => {
    keepRef.current = keep;
  }, [keep]);
  useEffect(() => {
    const flush = () => {
      if (timer.current !== null) keepRef.current();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      flush();
      if (changedRef.current && !closed.current && !window.lockin?.desktop) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", flush);
      // Navigating away inside the app: the draft is kept for next time.
      flush();
    };
  }, []);

  // Short notes fade on their own.
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(t);
  }, [note]);

  // ---------------------------------------------------------------------------

  const kind = view === "formatted" ? (toolbar?.kind ?? null) : mdKind;
  const status = saving ? "Saving…" : changed ? (kept ? "Unsaved — kept on this computer" : "Unsaved changes") : "";
  // Toolbar clicks leave the cursor, and the selection, where they were.
  const holdFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <section
      className="ed"
      aria-label="Editing the summary"
      onKeyDown={(e) => {
        if (e.key === "Escape" && lost) {
          setLost(null);
          focusView(viewRef.current);
        }
      }}
    >
      <div className="ed-bar">
        <div className="ed-seg" role="group" aria-label="Edit as">
          <button
            type="button"
            className="ed-seg-btn"
            aria-pressed={view === "formatted"}
            onMouseDown={holdFocus}
            onClick={() => view !== "formatted" && toFormatted()}
            title="Edit it as it looks"
          >
            Formatted
          </button>
          <button
            type="button"
            className="ed-seg-btn"
            aria-pressed={view === "markdown"}
            onMouseDown={holdFocus}
            onClick={() => view !== "markdown" && toMarkdown()}
            title="Edit the Markdown it is written in"
          >
            Markdown
          </button>
        </div>

        <span className="ed-sep" aria-hidden="true" />

        <div className="ed-group" role="group" aria-label="Line style">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className="ed-tool"
              aria-pressed={kind === k.kind}
              title={k.title}
              onMouseDown={holdFocus}
              onClick={() => chooseKind(k.kind)}
            >
              {k.label}
            </button>
          ))}
        </div>

        <span className="ed-sep" aria-hidden="true" />

        <div className="ed-group" role="group" aria-label="Text style">
          <button
            type="button"
            className="ed-tool ed-b"
            aria-pressed={view === "formatted" && !!toolbar?.bold}
            aria-label="Bold"
            title="Bold (Ctrl+B / ⌘B)"
            onMouseDown={holdFocus}
            onClick={() => chooseMark("**")}
          >
            B
          </button>
          <button
            type="button"
            className="ed-tool ed-i"
            aria-pressed={view === "formatted" && !!toolbar?.italic}
            aria-label="Italic"
            title="Italic (Ctrl+I / ⌘I)"
            onMouseDown={holdFocus}
            onClick={() => chooseMark("*")}
          >
            I
          </button>
        </div>

        <span className="ed-spacer" />

        <span className="ed-status small faint" aria-live="polite">
          {note ?? status}
        </span>
        <button type="button" className="btn sm quiet" onClick={cancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="btn sm primary"
          onClick={() => void save()}
          disabled={saving}
          title="Save (Ctrl+S / ⌘S)"
        >
          <Icon name="check" size={14} />
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {offer && (
        <div className="callout blue ed-banner" role="status">
          <Icon name="refresh" className="callout-icon" />
          <div className="ed-banner-body">
            <p>
              Restore your unsaved edits from {offer.when}?
              {offer.stale && " The summary has changed since — restoring them replaces those changes."}
            </p>
            <div className="row">
              <button type="button" className="btn sm" onClick={restore}>
                Restore
              </button>
              <button type="button" className="btn sm quiet" onClick={dismissOffer}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}

      {lost && view === "markdown" && (
        <div className="callout yellow ed-banner" role="status">
          <Icon name="alert" className="callout-icon" />
          <div className="ed-banner-body">
            <p>
              Some of this summary&apos;s formatting can only be edited as Markdown — switching may change it.
              <span className="ed-lost">
                {" "}
                It would lose {lost.slice(0, 6).map((w) => `“${w}”`).join(", ")}
                {lost.length > 6 ? ` and ${lost.length - 6} more` : ""}.
              </span>
            </p>
            <div className="row">
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setLost(null);
                  focusView("markdown");
                }}
              >
                Stay in Markdown
              </button>
              <button type="button" className="btn sm quiet" onClick={() => toFormatted(true)}>
                Switch anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {conflict && (
        <div className="callout red ed-banner" role="alert">
          <Icon name="alert" className="callout-icon" />
          <div className="ed-banner-body">
            <p>{conflict}</p>
            <div className="row">
              <button type="button" className="btn sm" onClick={() => void save(true)} disabled={saving}>
                Overwrite anyway
              </button>
              <button type="button" className="btn sm quiet" onClick={discardMine} disabled={saving}>
                Discard my edits
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="result err ed-error" role="alert">
          {error}
        </p>
      )}

      <div className="ed-body">
        <div hidden={view !== "formatted"}>
          {editor ? <EditorContent editor={editor} /> : <div className="prose ed-surface ed-loading" aria-hidden="true" />}
        </div>
        {view === "markdown" && (
          <textarea
            ref={textRef}
            className="ed-md"
            aria-label="Summary, as Markdown"
            value={text}
            spellCheck
            onChange={(e) => {
              textValue.current = e.target.value;
              setText(e.target.value);
              setMdKind(lineKindAt(e.target.value, e.target.selectionStart));
              markChanged();
            }}
            onSelect={trackKind}
            onKeyUp={trackKind}
            onMouseUp={trackKind}
            onFocus={trackKind}
            onKeyDown={onTextKey}
          />
        )}
      </div>

      <p className="ed-help small faint">
        Tab and Shift+Tab move a dot point in and out. {view === "formatted" ? "Type “- ” for a dot point or “## ” for a heading. " : ""}
        Ctrl+S or ⌘S saves. Until then your edits are kept on this computer.
      </p>
    </section>
  );
}
