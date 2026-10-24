"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { setSlideCrop } from "@/app/study-actions";
import { cleanCrop, parseCrop, type Crop } from "@/lib/markdown";

interface Target {
  figure: number;
  slide: number;
  crop: Crop | null;
}

/**
 * The Crop button on each slide picture in a summary (rendered with the summary's HTML)
 * opens this: the whole slide, a box to drag over the part worth keeping, and Save.
 * Listens on the summary rather than on each button, as the summary's HTML is replaced
 * whenever it changes.
 */
export function SlideCropper({ lectureId, containerId, base }: { lectureId: string; containerId: string; base: string }) {
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) return;
    const onClick = (e: MouseEvent) => {
      const button = (e.target as Element | null)?.closest?.("button.slide-crop") as HTMLButtonElement | null;
      if (!button) return;
      e.preventDefault();
      setTarget({
        figure: Number(button.dataset.fig),
        slide: Number(button.dataset.slide),
        crop: parseCrop(button.dataset.crop),
      });
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [containerId]);

  if (!target) return null;
  return (
    <CropDialog
      key={`${target.figure}:${target.slide}`}
      lectureId={lectureId}
      src={`${base}/${target.slide}`}
      target={target}
      onClose={() => setTarget(null)}
    />
  );
}

type Handle = "nw" | "ne" | "sw" | "se";
type Drag =
  | { kind: "new"; x: number; y: number }
  | { kind: "move"; x: number; y: number; from: Crop }
  | { kind: "resize"; handle: Handle; from: Crop };

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** A box from two corners, in either order. */
function between(ax: number, ay: number, bx: number, by: number): Crop {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

function CropDialog({
  lectureId,
  src,
  target,
  onClose,
}: {
  lectureId: string;
  src: string;
  target: Target;
  onClose: () => void;
}) {
  const [box, setBox] = useState<Crop | null>(target.crop);
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Where the pointer is on the slide, as fractions of it. */
  const at = (e: React.PointerEvent) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = at(e);
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    if (handle && box) drag.current = { kind: "resize", handle, from: box };
    else if (box && p.x > box.x && p.x < box.x + box.w && p.y > box.y && p.y < box.y + box.h) {
      drag.current = { kind: "move", x: p.x, y: p.y, from: box };
    } else {
      drag.current = { kind: "new", x: p.x, y: p.y };
      setBox({ x: p.x, y: p.y, w: 0, h: 0 });
    }
    frame.current!.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = at(e);
    if (d.kind === "new") setBox(between(d.x, d.y, p.x, p.y));
    else if (d.kind === "move") {
      const x = Math.min(1 - d.from.w, Math.max(0, d.from.x + p.x - d.x));
      const y = Math.min(1 - d.from.h, Math.max(0, d.from.y + p.y - d.y));
      setBox({ ...d.from, x, y });
    } else {
      // The corner opposite the one being dragged stays put.
      const { x, y, w, h } = d.from;
      const fixedX = d.handle.includes("w") ? x + w : x;
      const fixedY = d.handle.includes("n") ? y + h : y;
      setBox(between(fixedX, fixedY, p.x, p.y));
    }
  };

  const onUp = () => {
    drag.current = null;
  };

  const usable = cleanCrop(box);
  const save = (crop: Crop | null) =>
    start(async () => {
      const res = await setSlideCrop({ lectureId, figure: target.figure, slide: target.slide, crop });
      if (res.ok) onClose();
      else setError(res.message);
    });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide crop-modal" role="dialog" aria-modal="true" aria-label={`Crop slide ${target.slide}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <h2 style={{ fontSize: 19 }}>Crop slide {target.slide}</h2>
          <p className="small">Drag a box over the part worth keeping. Drag inside it to move it, or a corner to resize it.</p>
          <div
            ref={frame}
            className="crop-frame"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a slide drawn on request, not a static asset */}
            <img src={src} alt={`Slide ${target.slide}`} draggable={false} />
            {box && box.w > 0 && box.h > 0 && (
              <div
                className="crop-box"
                style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
              >
                {(["nw", "ne", "sw", "se"] as const).map((h) => (
                  <span key={h} className={`crop-handle ${h}`} data-handle={h} />
                ))}
              </div>
            )}
          </div>
          {error && <p className="result err" style={{ marginTop: 8 }}>{error}</p>}
        </div>
        <div className="modal-foot">
          {target.crop && (
            <button type="button" className="btn quiet" disabled={saving} onClick={() => save(null)}>
              Show the whole slide
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!usable || saving} onClick={() => save(usable)}>
            {saving ? "Saving…" : "Save crop"}
          </button>
        </div>
      </div>
    </div>
  );
}
