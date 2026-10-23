"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import "@/app/ak/[id]/cards/cards.css";
import { PictureEditor } from "@/app/ak/[id]/cards/PictureEditor";
import { parseCrop, slidePictureUrl } from "@/lib/markdown";

/**
 * The Cover-up cards button on each slide picture in a summary opens the cover-up editor
 * on that slide, cropped as it is shown, with a box already over each label. The cards
 * go into the lecture's AK deck.
 */
export function SlideOccluder({ lectureId, containerId, base }: { lectureId: string; containerId: string; base: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) return;
    const onClick = (e: MouseEvent) => {
      const button = (e.target as Element | null)?.closest?.("button.slide-occlude") as HTMLButtonElement | null;
      if (!button) return;
      e.preventDefault();
      setDone(null);
      setSrc(slidePictureUrl(base, Number(button.dataset.slide), parseCrop(button.dataset.crop)));
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [containerId, base]);

  return (
    <>
      {src && (
        <PictureEditor
          key={src}
          lectureId={lectureId}
          mode="occlusion"
          slides={{ base, numbers: [] }}
          startUrl={src}
          onDone={setDone}
          onClose={() => setSrc(null)}
        />
      )}
      {done && (
        <div className="callout green occlude-done" role="status">
          <span>{done}</span>
          <Link href={`/ak/${lectureId}`} className="btn sm">
            Review them
          </Link>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => setDone(null)}>
            ×
          </button>
        </div>
      )}
    </>
  );
}
