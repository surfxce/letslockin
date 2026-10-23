"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { importCardBatch, removeCards, saveOwnCard } from "@/app/ak/actions";
import { PictureEditor } from "@/app/ak/[id]/cards/PictureEditor";
import { Icon } from "@/app/ui/Icon";
import { Markdown } from "@/app/ui/render";
import { cardsFromRows, MAX_IMPORT_CARDS, parseCardFile, type CardFile } from "@/lib/flashcards/csv";
import type { SlideImages } from "@/lib/markdown";

export interface WorkshopCard {
  id: string;
  front: string;
  back: string;
  /** Rendered on the server, so a long list doesn't render Markdown in the browser. */
  frontHtml: string;
  backHtml: string;
  origin: string;
  state: string;
  due: string;
}

type Panel = "write" | "occlusion" | "csv";
type Field = "front" | "back";

const ORIGIN: Record<string, string> = { ai: "Generated", manual: "Yours", csv: "Imported", occlusion: "Cover-up" };

export function CardsWorkshop({
  lectureId,
  slides,
  pictures,
  cards,
  initialPanel,
}: {
  lectureId: string;
  /** For showing slide:N pictures in previews. */
  slides: SlideImages;
  /** For choosing a slide as the picture to draw on. */
  pictures: { base: string; numbers: number[] };
  cards: WorkshopCard[];
  initialPanel: Panel;
}) {
  const [panel, setPanel] = useState<Panel>(initialPanel);
  const [editing, setEditing] = useState<WorkshopCard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [occluding, setOccluding] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  return (
    <div ref={top}>
      <div className="views ws-tabs" role="tablist">
        {(
          [
            ["write", "Write a card", "pen"],
            ["occlusion", "Cover-up cards", "scissors"],
            ["csv", "Import a CSV", "upload"],
          ] as const
        ).map(([id, label, icon]) => (
          <button key={id} type="button" role="tab" aria-selected={panel === id} className={`view${panel === id ? " on" : ""}`} onClick={() => {
              setPanel(id);
              setNotice(null);
            }}>
            <Icon name={icon} size={14} /> {label}
          </button>
        ))}
      </div>
      {notice && (
        <div className="callout green" role="status">
          <Icon name="check" size={16} /> {notice}
        </div>
      )}

      {panel === "write" && (
        <CardForm
          key={editing?.id ?? "new"}
          lectureId={lectureId}
          slides={slides}
          pictures={pictures}
          editing={editing}
          onSaved={(message) => {
            setNotice(message);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {panel === "occlusion" && (
        <div className="soft-card ws-occlusion">
          <p>
            Pick a diagram or a labelled slide, then draw a box over each label or part you want to learn. Every box becomes its own card: the front
            covers it, the back shows it — like Anki&apos;s image occlusion.
          </p>
          <button type="button" className="btn primary" onClick={() => setOccluding(true)}>
            <Icon name="scissors" size={15} /> Choose a picture
          </button>
          {occluding && (
            <PictureEditor
              lectureId={lectureId}
              mode="occlusion"
              slides={pictures}
              onDone={setNotice}
              onClose={() => setOccluding(false)}
            />
          )}
        </div>
      )}
      {panel === "csv" && <CsvImport lectureId={lectureId} onDone={setNotice} />}

      <CardList
        lectureId={lectureId}
        cards={cards}
        onEdit={(card) => {
          setEditing(card);
          setPanel("write");
          setNotice(null);
          top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        onDeleted={setNotice}
      />
    </div>
  );
}

/** Front and back in Markdown, with a few buttons for those who'd rather not type it. */
function CardForm({
  lectureId,
  slides,
  pictures,
  editing,
  onSaved,
  onCancel,
}: {
  lectureId: string;
  slides: SlideImages;
  pictures: { base: string; numbers: number[] };
  editing: WorkshopCard | null;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState<Record<Field, string>>({ front: editing?.front ?? "", back: editing?.back ?? "" });
  const [preview, setPreview] = useState(false);
  const [picture, setPicture] = useState<{ field: Field; start: File | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const boxes = { front: useRef<HTMLTextAreaElement>(null), back: useRef<HTMLTextAreaElement>(null) };

  /** Replaces the selection in one box, keeping the cursor after what went in. */
  function edit(field: Field, change: (selected: string) => string) {
    const box = boxes[field].current;
    const value = text[field];
    const start = box?.selectionStart ?? value.length;
    const end = box?.selectionEnd ?? value.length;
    const inserted = change(value.slice(start, end));
    setText((t) => ({ ...t, [field]: value.slice(0, start) + inserted + value.slice(end) }));
    requestAnimationFrame(() => {
      if (!box) return;
      box.focus();
      const at = start + inserted.length;
      box.setSelectionRange(at, at);
    });
  }
  const wrap = (field: Field, mark: string) => edit(field, (s) => `${mark}${s || "text"}${mark}`);
  const bullets = (field: Field) =>
    edit(field, (s) =>
      (s || "point")
        .split("\n")
        .map((l) => (l.startsWith("- ") ? l : `- ${l}`))
        .join("\n"),
    );
  const insertPicture = (field: Field, url: string) => edit(field, () => `\n![Picture](${url})\n`);

  function save() {
    setError(null);
    startSaving(async () => {
      const result = await saveOwnCard(lectureId, { id: editing?.id, front: text.front, back: text.back });
      if (!result.ok) return setError(result.message);
      setText({ front: "", back: "" });
      setPreview(false);
      onSaved(result.message);
      requestAnimationFrame(() => boxes.front.current?.focus());
    });
  }

  return (
    <div className="ws-form">
      {(["front", "back"] as const).map((field) => (
        <div key={field} className="ws-side">
          <div className="ws-side-head">
            <span className="ak-eyebrow">{field === "front" ? "Front · the question" : "Back · the answer"}</span>
            <span className="spacer" />
            {!preview && (
              <div className="ws-format" role="toolbar" aria-label={`Format the ${field}`}>
                <button type="button" className="icon-btn" title="Bold" onClick={() => wrap(field, "**")}>
                  <b>B</b>
                </button>
                <button type="button" className="icon-btn" title="Italic" onClick={() => wrap(field, "*")}>
                  <i>I</i>
                </button>
                <button type="button" className="icon-btn" title="Bullet points" onClick={() => bullets(field)}>
                  <Icon name="list" size={15} />
                </button>
                <button type="button" className="btn sm quiet" onClick={() => setPicture({ field, start: null })}>
                  <Icon name="upload" size={14} /> Picture
                </button>
              </div>
            )}
          </div>
          {preview ? (
            <div className="ws-preview ak-card-content">
              {text[field].trim() ? <Markdown md={text[field]} className="prose" slides={slides} /> : <span className="faint">Nothing yet.</span>}
            </div>
          ) : (
            <textarea
              ref={boxes[field]}
              value={text[field]}
              rows={field === "front" ? 3 : 4}
              placeholder={field === "front" ? "What does insulin do to blood glucose?" : "Lowers it — glucose is taken up into muscle and fat."}
              onChange={(e) => setText((t) => ({ ...t, [field]: e.target.value }))}
              onPaste={(e) => {
                const item = Array.from(e.clipboardData.items).find((i) => i.kind === "file" && i.type.startsWith("image/"));
                const file = item?.getAsFile();
                if (file) {
                  e.preventDefault();
                  setPicture({ field, start: file });
                }
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  save();
                }
              }}
              aria-label={field === "front" ? "Front of the card" : "Back of the card"}
            />
          )}
        </div>
      ))}
      <div className="row ws-actions">
        <button type="button" className="btn primary" disabled={saving || !text.front.trim() || !text.back.trim()} onClick={save}>
          {saving ? "Saving…" : editing ? "Save changes" : "Add card"}
        </button>
        <button type="button" className="btn" onClick={() => setPreview((p) => !p)}>
          {preview ? "Edit" : "Preview"}
        </button>
        {editing && (
          <button type="button" className="btn quiet" onClick={onCancel}>
            Cancel editing
          </button>
        )}
        <span className="small faint">Markdown works: **bold**, *italics*, - lists. Paste a picture straight in. ⌘↵ adds the card.</span>
        {error && (
          <span className="result err" role="alert">
            {error}
          </span>
        )}
      </div>
      {picture && (
        <PictureEditor
          lectureId={lectureId}
          mode="insert"
          slides={pictures}
          start={picture.start}
          onInsert={(url) => insertPicture(picture.field, url)}
          onClose={() => setPicture(null)}
        />
      )}
    </div>
  );
}

/** A spreadsheet or an Anki export, previewed before anything is added. */
function CsvImport({ lectureId, onDone }: { lectureId: string; onDone: (message: string) => void }) {
  const [file, setFile] = useState<{ name: string; parsed: CardFile } | null>(null);
  const [front, setFront] = useState(0);
  const [back, setBack] = useState(1);
  const [html, setHtml] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");

  function read(name: string, raw: string) {
    setError(null);
    const parsed = parseCardFile(raw);
    if (!parsed.rows.length) return setError("No rows found in that file.");
    setFile({ name, parsed });
    setFront(0);
    setBack(Math.min(1, Math.max(...parsed.rows.slice(0, 20).map((r) => r.length)) - 1));
    setHtml(parsed.html);
  }

  const columns = useMemo(() => {
    if (!file) return [];
    const n = Math.max(...file.parsed.rows.slice(0, 50).map((r) => r.length));
    return Array.from({ length: n }, (_, i) => file.parsed.header?.[i]?.trim() || `Column ${i + 1}`);
  }, [file]);
  const cards = useMemo(() => (file ? cardsFromRows(file.parsed.rows, front, back, html) : []), [file, front, back, html]);

  async function run() {
    setError(null);
    let added = 0;
    let skipped = 0;
    try {
      // In batches: the server takes only so much in one go.
      for (let i = 0; i < cards.length; i += 250) {
        setProgress(`Importing ${Math.min(i + 250, cards.length)} of ${cards.length}…`);
        const result = await importCardBatch(lectureId, cards.slice(i, i + 250));
        if (!result.ok) throw new Error(result.message);
        added += result.added;
        skipped += result.skipped;
      }
      setFile(null);
      setPasted("");
      onDone(`Imported ${added} card${added === 1 ? "" : "s"}${skipped ? `; ${skipped} already in the deck were skipped` : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="soft-card ws-csv">
      {!file ? (
        <>
          <p>
            One card per row: a column for the front and one for the back. Comma-, tab- or semicolon-separated files work, and so do Anki exports
            (<i>File → Export → Notes in Plain Text</i>), formatting and cloze deletions included.
          </p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="btn primary">
              <Icon name="upload" size={15} /> Choose a file
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  if (f.size > 20 * 1024 * 1024) return setError("That file is too big (20 MB at most).");
                  read(f.name, await f.text());
                }}
              />
            </label>
            <span className="small muted">or paste the rows:</span>
          </div>
          <textarea
            className="ws-paste"
            rows={4}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={"Front,Back\nWhat lowers blood glucose?,Insulin"}
            aria-label="Paste rows"
          />
          <div className="row">
            <button type="button" className="btn sm" disabled={!pasted.trim()} onClick={() => read("Pasted rows", pasted)}>
              Preview
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <b>{file.name}</b>
            <span className="small muted">
              {file.parsed.rows.length} rows · {file.parsed.delimiter === "\t" ? "tab" : `“${file.parsed.delimiter}”`}-separated
            </span>
            <span className="spacer" />
            <button type="button" className="btn sm quiet" onClick={() => setFile(null)}>
              Choose another
            </button>
          </div>
          <div className="row ws-columns">
            <label className="field">
              <span>Front</span>
              <select value={front} onChange={(e) => setFront(Number(e.target.value))}>
                {columns.map((c, i) => (
                  <option key={i} value={i}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Back</span>
              <select value={back} onChange={(e) => setBack(Number(e.target.value))}>
                {columns.map((c, i) => (
                  <option key={i} value={i}>
                    {c}
                  </option>
                ))}
                <option value={-1}>Nothing (cloze only)</option>
              </select>
            </label>
            <label className="row small">
              <input type="checkbox" checked={html} onChange={(e) => setHtml(e.target.checked)} /> Cells are HTML (Anki)
            </label>
          </div>
          <div className="db-wrap">
            <table className="db ws-preview-table">
              <thead>
                <tr>
                  <th>Front</th>
                  <th>Back</th>
                </tr>
              </thead>
              <tbody>
                {cards.slice(0, 5).map((c, i) => (
                  <tr key={i}>
                    <td>{c.front}</td>
                    <td>{c.back}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button type="button" className="btn primary" disabled={!cards.length || !!progress} onClick={run}>
              Import {cards.length} card{cards.length === 1 ? "" : "s"}
            </button>
            {progress && <span className="small muted">{progress}</span>}
            {cards.length < file.parsed.rows.length && (
              <span className="small faint">
                {file.parsed.rows.length - cards.length} row{file.parsed.rows.length - cards.length === 1 ? " has" : "s have"} an empty side and
                {file.parsed.rows.length - cards.length === 1 ? " is" : " are"} left out
                {cards.length >= MAX_IMPORT_CARDS ? ` (or past ${MAX_IMPORT_CARDS})` : ""}.
              </span>
            )}
          </div>
        </>
      )}
      {error && (
        <p className="result err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function CardList({
  lectureId,
  cards,
  onEdit,
  onDeleted,
}: {
  lectureId: string;
  cards: WorkshopCard[];
  onEdit: (card: WorkshopCard) => void;
  onDeleted: (message: string) => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Cards gone from this page (deleted, or another page) can't stay chosen.
    queueMicrotask(() => setChosen((prev) => new Set([...prev].filter((id) => cards.some((c) => c.id === id)))));
  }, [cards]);

  function remove(ids: string[]) {
    if (!ids.length || !window.confirm(`Delete ${ids.length === 1 ? "this card" : `${ids.length} cards`} and ${ids.length === 1 ? "its" : "their"} review history?`)) return;
    setError(null);
    start(async () => {
      const result = await removeCards(lectureId, ids);
      if (!result.ok) return setError(result.message);
      onDeleted(result.message);
    });
  }

  if (!cards.length) return null;
  const all = cards.every((c) => chosen.has(c.id));
  return (
    <section className="ws-list">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Cards</h2>
        <span className="spacer" />
        {chosen.size > 0 && (
          <button type="button" className="btn sm danger" disabled={pending} onClick={() => remove([...chosen])}>
            <Icon name="trash" size={14} /> Delete {chosen.size}
          </button>
        )}
        {error && (
          <span className="result err" role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="db-wrap">
        <table className="db ws-table">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input
                  type="checkbox"
                  aria-label="Choose every card on this page"
                  checked={all}
                  onChange={() => setChosen(all ? new Set() : new Set(cards.map((c) => c.id)))}
                />
              </th>
              <th>Front</th>
              <th>Back</th>
              <th>Kind</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label="Choose this card"
                    checked={chosen.has(c.id)}
                    onChange={(e) =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        return next;
                      })
                    }
                  />
                </td>
                <td>
                  <div className="prose ws-cell" dangerouslySetInnerHTML={{ __html: c.frontHtml }} />
                </td>
                <td>
                  <div className="prose ws-cell" dangerouslySetInnerHTML={{ __html: c.backHtml }} />
                </td>
                <td className="small muted">
                  {ORIGIN[c.origin] ?? c.origin}
                  <div className="faint">{c.state === "new" ? "new" : c.due}</div>
                </td>
                <td className="ws-row-actions">
                  {c.origin !== "occlusion" && (
                    <button type="button" className="btn sm" onClick={() => onEdit(c)}>
                      Edit
                    </button>
                  )}
                  <button type="button" className="icon-btn" aria-label="Delete this card" disabled={pending} onClick={() => remove([c.id])}>
                    <Icon name="trash" size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
