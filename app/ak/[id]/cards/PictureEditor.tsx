"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { saveCoverUpCards } from "@/app/ak/actions";
import { Icon } from "@/app/ui/Icon";

type Tool = "pen" | "ellipse" | "box" | "arrow" | "cover" | "eraser";
type Pt = { x: number; y: number };
type Shape =
  | { kind: "pen"; color: string; width: number; points: Pt[] }
  | { kind: "ellipse" | "box" | "arrow"; color: string; width: number; a: Pt; b: Pt }
  | { kind: "cover"; a: Pt; b: Pt };

/** How cover-up cards hide the other boxes: all covered while one is asked, or only the one asked. */
type Hide = "all" | "one";

/** Pictures bigger than this are scaled down: plenty for a card, and quick to save. */
const MAX_SIDE = 2000;
const COLORS = ["#e03e3e", "#d9730d", "#0b6e99", "#0f7b6c", "#111111"];
const COVER_FILL = "#ffeba2";
const COVER_EDGE = "#6b5a1e";
const TARGET_FILL = "#ff8a80";
const TARGET_EDGE = "#c62828";

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: React.ReactNode }> = [
  { id: "pen", label: "Draw", key: "d", icon: <path d="M4 20c4-1 6-4 9-8l4-4 3 3-4 4c-4 3-7 5-8 9z" /> },
  { id: "ellipse", label: "Circle", key: "c", icon: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" /> },
  { id: "box", label: "Box", key: "b", icon: <rect x="4" y="6" width="16" height="12" rx="1" /> },
  { id: "arrow", label: "Arrow", key: "a", icon: <path d="M5 19 19 5m0 0h-8m8 0v8" /> },
  { id: "cover", label: "Cover up", key: "h", icon: <rect x="4" y="7" width="16" height="10" rx="1" fill="currentColor" fillOpacity={0.35} /> },
  { id: "eraser", label: "Remove", key: "e", icon: <path d="m8 20 12-12-4-4L4 16l4 4h12M10 10l4 4" /> },
];

function rectOf(a: Pt, b: Pt) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Draws the picture with its marks. `ask` draws the cards of one cover-up box instead of the editing view. */
function paint(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  shapes: Shape[],
  ask?: { target: number; side: "front" | "back"; hide: Hide },
  numbered = false,
) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const edge = Math.max(1.5, width / 700);
  let cover = -1;
  for (const s of shapes) {
    if (s.kind === "cover") {
      cover++;
      const r = rectOf(s.a, s.b);
      const isTarget = ask && cover === ask.target;
      if (ask && !isTarget && ask.hide === "one") continue;
      if (isTarget && ask.side === "back") {
        ctx.strokeStyle = TARGET_EDGE;
        ctx.lineWidth = edge * 2.5;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        continue;
      }
      ctx.fillStyle = isTarget ? TARGET_FILL : COVER_FILL;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = isTarget ? TARGET_EDGE : COVER_EDGE;
      ctx.lineWidth = edge;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      const label = isTarget ? "?" : numbered && !ask ? String(cover + 1) : "";
      if (label) {
        const size = Math.max(12, Math.min(r.h * 0.6, r.w * 0.6, width / 18));
        ctx.fillStyle = isTarget ? "#7f0000" : COVER_EDGE;
        ctx.font = `600 ${size}px -apple-system, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
      }
      continue;
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    if (s.kind === "pen") {
      s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.1, s.points[0].y);
    } else if (s.kind === "box") {
      const r = rectOf(s.a, s.b);
      ctx.rect(r.x, r.y, r.w, r.h);
    } else if (s.kind === "ellipse") {
      const r = rectOf(s.a, s.b);
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(1, r.w / 2), Math.max(1, r.h / 2), 0, 0, Math.PI * 2);
    } else {
      const angle = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
      const head = Math.max(10, s.width * 4);
      ctx.moveTo(s.a.x, s.a.y);
      ctx.lineTo(s.b.x, s.b.y);
      ctx.moveTo(s.b.x - head * Math.cos(angle - 0.45), s.b.y - head * Math.sin(angle - 0.45));
      ctx.lineTo(s.b.x, s.b.y);
      ctx.lineTo(s.b.x - head * Math.cos(angle + 0.45), s.b.y - head * Math.sin(angle + 0.45));
    }
    ctx.stroke();
  }
}

/** The topmost mark under a point, for the remove tool. */
function hit(shapes: Shape[], p: Pt, slack: number): number {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.kind === "pen") {
      if (s.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < slack + s.width)) return i;
      continue;
    }
    if (s.kind === "arrow") {
      const { a, b } = s;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len)));
      if (Math.hypot(a.x + t * (b.x - a.x) - p.x, a.y + t * (b.y - a.y) - p.y) < slack + s.width) return i;
      continue;
    }
    const r = rectOf(s.a, s.b);
    if (p.x >= r.x - slack && p.x <= r.x + r.w + slack && p.y >= r.y - slack && p.y <= r.y + r.h + slack) return i;
  }
  return -1;
}

async function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.92));
  if (webp && webp.type === "image/webp") return webp;
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png) throw new Error("Couldn't make the picture.");
  return png;
}

/** Saves a picture for a card and gives back its name and address. */
export async function uploadCardImage(blob: Blob): Promise<{ name: string; url: string }> {
  const res = await fetch("/api/ak/images", { method: "POST", body: blob, headers: { "content-type": blob.type || "application/octet-stream" } });
  const json = (await res.json().catch(() => ({}))) as { name?: string; url?: string; error?: string };
  if (!res.ok || !json.name || !json.url) throw new Error(json.error ?? "Couldn't save that picture.");
  return { name: json.name, url: json.url };
}

function imageFile(items: DataTransferItemList | FileList | null | undefined): File | null {
  if (!items) return null;
  for (const item of Array.from(items as ArrayLike<DataTransferItem | File>)) {
    const file = item instanceof File ? item : item.kind === "file" ? item.getAsFile() : null;
    if (file && file.type.startsWith("image/")) return file;
  }
  return null;
}

/**
 * A picture to draw on: circle things, box them, point at them, or cover parts up.
 * As "insert" it hands back one finished picture for a card; as "occlusion" every
 * cover-up box becomes a card of its own, Anki-style.
 */
export function PictureEditor({
  lectureId,
  mode,
  slides,
  start,
  onInsert,
  onDone,
  onClose,
}: {
  lectureId: string;
  mode: "insert" | "occlusion";
  slides: { base: string; numbers: number[] };
  /** A picture to begin with — one pasted into a card, say. */
  start?: File | null;
  onInsert?: (url: string) => void;
  onDone?: (message: string) => void;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [undone, setUndone] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool>(mode === "occlusion" ? "cover" : "ellipse");
  const [color, setColor] = useState(COLORS[0]);
  const [weight, setWeight] = useState(2);
  const [hide, setHide] = useState<Hide>("all");
  const [prompt, setPrompt] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = useRef<Shape | null>(null);
  const objectUrl = useRef<string | null>(null);

  const covers = shapes.filter((s) => s.kind === "cover").length;

  const load = useCallback((src: string | File) => {
    setError(null);
    setLoading(true);
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    const url = typeof src === "string" ? src : (objectUrl.current = URL.createObjectURL(src));
    const image = new Image();
    image.onload = () => {
      setLoading(false);
      setImg(image);
      setShapes([]);
      setUndone([]);
    };
    image.onerror = () => {
      setLoading(false);
      setError("That picture couldn't be opened.");
    };
    image.src = url;
  }, []);

  useEffect(() => {
    // A picture handed in from outside is the starting point; loading it ends in setState.
    if (start) queueMicrotask(() => load(start));
  }, [start, load]);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const redraw = useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !img) return;
    paint(ctx, img, draft.current ? [...shapes, draft.current] : shapes, undefined, mode === "occlusion");
  }, [img, shapes, mode]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    redraw();
  }, [img, redraw]);

  const undo = useCallback(() => {
    setShapes((all) => {
      if (!all.length) return all;
      setUndone((u) => [...u, all[all.length - 1]]);
      return all.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setUndone((u) => {
      if (!u.length) return u;
      setShapes((all) => [...all, u[u.length - 1]]);
      return u.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "Escape") onClose();
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
        if (t) setTool(t.id);
      }
    }
    function onPaste(e: ClipboardEvent) {
      const file = imageFile(e.clipboardData?.items);
      if (file && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        load(file);
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [load, onClose, undo, redo]);

  function point(e: React.PointerEvent<HTMLCanvasElement>): Pt {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  }
  const strokeWidth = () => {
    const c = canvas.current;
    const base = Math.max(2, (c?.width ?? 800) / 300);
    return base * [0.6, 1, 1.8][weight - 1];
  };

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!img || e.button !== 0) return;
    const p = point(e);
    if (tool === "eraser") {
      const c = e.currentTarget;
      const i = hit(shapes, p, (8 * c.width) / c.getBoundingClientRect().width);
      if (i >= 0) {
        setUndone([]);
        setShapes((all) => all.filter((_, k) => k !== i));
      }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    draft.current =
      tool === "pen"
        ? { kind: "pen", color, width: strokeWidth(), points: [p] }
        : tool === "cover"
          ? { kind: "cover", a: p, b: p }
          : { kind: tool, color, width: strokeWidth(), a: p, b: p };
    redraw();
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = draft.current;
    if (!d) return;
    const p = point(e);
    if (d.kind === "pen") d.points.push(p);
    else d.b = p;
    redraw();
  }
  function up() {
    const d = draft.current;
    draft.current = null;
    if (!d) return;
    const tiny = d.kind === "pen" ? false : Math.hypot(d.a.x - d.b.x, d.a.y - d.b.y) < 4;
    if (tiny) return redraw();
    setUndone([]);
    setShapes((all) => [...all, d]);
  }

  async function render(ask?: { target: number; side: "front" | "back"; hide: Hide }) {
    const c = canvas.current!;
    const out = document.createElement("canvas");
    out.width = c.width;
    out.height = c.height;
    paint(out.getContext("2d")!, img!, shapes, ask);
    return canvasBlob(out);
  }

  async function insert() {
    setError(null);
    setBusy("Saving the picture…");
    try {
      const { url } = await uploadCardImage(await render());
      onInsert?.(url);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function makeCards() {
    setError(null);
    try {
      const cards: Array<{ front: string; back: string }> = [];
      for (let i = 0; i < covers; i++) {
        setBusy(`Drawing card ${i + 1} of ${covers}…`);
        const [front, back] = await Promise.all([
          render({ target: i, side: "front", hide }).then(uploadCardImage),
          render({ target: i, side: "back", hide }).then(uploadCardImage),
        ]);
        cards.push({ front: front.name, back: back.name });
      }
      setBusy("Saving the cards…");
      const result = await saveCoverUpCards(lectureId, { prompt, extra, cards });
      if (!result.ok) throw new Error(result.message);
      onDone?.(result.message);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={mode === "occlusion" ? "Cover-up cards" : "Picture"}>
      <div className="modal pe">
        <div className="pe-head">
          <b>{mode === "occlusion" ? "Cover-up cards from a picture" : "Add a picture"}</b>
          <span className="spacer" />
          {img && (
            <button type="button" className="btn sm quiet" onClick={() => setImg(null)}>
              Change picture
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {!img ? (
          <Chooser slides={slides} loading={loading} onFile={load} onSlide={(n) => load(`${slides.base}/${n}`)} />
        ) : (
          <>
            <div className="pe-tools" role="toolbar" aria-label="Drawing tools">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`pe-tool${tool === t.id ? " on" : ""}`}
                  aria-pressed={tool === t.id}
                  title={`${t.label} (${t.key.toUpperCase()})`}
                  onClick={() => setTool(t.id)}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {t.icon}
                  </svg>
                  <span>{t.label}</span>
                </button>
              ))}
              <span className="pe-sep" />
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`pe-swatch${color === c ? " on" : ""}`}
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                />
              ))}
              <select value={weight} onChange={(e) => setWeight(Number(e.target.value))} aria-label="Line thickness" className="pe-weight">
                <option value={1}>Thin</option>
                <option value={2}>Medium</option>
                <option value={3}>Thick</option>
              </select>
              <span className="pe-sep" />
              <button type="button" className="btn sm quiet" onClick={undo} disabled={!shapes.length} title="Undo (⌘Z)">
                Undo
              </button>
              <button type="button" className="btn sm quiet" onClick={redo} disabled={!undone.length} title="Redo (⇧⌘Z)">
                Redo
              </button>
              <button
                type="button"
                className="btn sm quiet"
                disabled={!shapes.length}
                onClick={() => {
                  setUndone([]);
                  setShapes([]);
                }}
              >
                Clear
              </button>
            </div>
            <div className="pe-stage">
              <canvas
                ref={canvas}
                className={`pe-canvas tool-${tool}`}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
              />
            </div>
            <p className="small muted pe-hint">
              {mode === "occlusion"
                ? covers
                  ? `${covers} box${covers === 1 ? "" : "es"} — each becomes a card. The box being asked shows red with a “?”.`
                  : "Draw a box over each label or part to learn. Each box becomes a card."
                : tool === "cover"
                  ? "Drag over anything to hide it on the card."
                  : "Drag to draw on the picture."}
            </p>
          </>
        )}

        {img && mode === "occlusion" && (
          <div className="pe-options">
            <div className="pe-hide" role="radiogroup" aria-label="Other boxes">
              <label>
                <input type="radio" checked={hide === "all"} onChange={() => setHide("all")} /> Hide all, guess one
              </label>
              <label>
                <input type="radio" checked={hide === "one"} onChange={() => setHide("one")} /> Hide one, guess one
              </label>
            </div>
            <label className="field">
              <span>Question on the front</span>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What's under the box?" maxLength={2000} />
            </label>
            <label className="field">
              <span>Extra on the back (optional)</span>
              <textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} maxLength={5000} placeholder="Anything to read once it's revealed." />
            </label>
          </div>
        )}

        <div className="modal-foot">
          {error && (
            <span className="result err" role="alert">
              {error}
            </span>
          )}
          {busy && <span className="small muted">{busy}</span>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {mode === "insert" ? (
            <button type="button" className="btn primary" disabled={!img || !!busy} onClick={insert}>
              Insert picture
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={!img || !covers || !!busy} onClick={makeCards}>
              Make {covers || ""} card{covers === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where the picture comes from: a file, the clipboard, or one of the lecture's slides. */
function Chooser({
  slides,
  loading,
  onFile,
  onSlide,
}: {
  slides: { base: string; numbers: number[] };
  loading: boolean;
  onFile: (file: File) => void;
  onSlide: (n: number) => void;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="pe-choose">
      <div
        className={`pe-drop${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = imageFile(e.dataTransfer.files);
          if (file) onFile(file);
        }}
      >
        <Icon name="upload" size={22} />
        <div>
          {loading ? "Opening…" : "Drop a picture here, paste one (⌘V), or"}{" "}
          {!loading && (
            <button type="button" className="link" onClick={() => input.current?.click()}>
              choose a file
            </button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const file = imageFile(e.target.files);
            if (file) onFile(file);
            e.target.value = "";
          }}
        />
      </div>
      {slides.numbers.length > 0 && (
        <>
          <div className="small muted" style={{ margin: "14px 0 8px" }}>
            Or a slide from this lecture
          </div>
          <div className="pe-slides">
            {slides.numbers.map((n) => (
              <button key={n} type="button" className="pe-slide" onClick={() => onSlide(n)} title={`Slide ${n}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- slides are drawn on request by the app's own route */}
                <img src={`${slides.base}/${n}`} alt={`Slide ${n}`} loading="lazy" />
                <span>{n}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
