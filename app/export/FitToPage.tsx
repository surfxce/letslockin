"use client";

import { useEffect } from "react";

/** The tallest a slide picture prints: a 4:3 slide at full width just fits. */
const MAX_PICTURE_MM = 140;
const PX_PER_MM = 96 / 25.4;

/**
 * Keeps the document within its pages. A picture taller than MAX_PICTURE_MM is
 * narrowed, keeping its shape, so its frame still fits it; a table wider than the
 * page wraps its words rather than being cut off at the edge. Runs in the preview
 * and in the desktop app's print window alike.
 */
export function FitToPage({ watch }: { watch: string }) {
  useEffect(() => {
    const doc = document.querySelector(".export-doc");
    if (!doc) return;

    for (const table of doc.querySelectorAll<HTMLTableElement>(".prose table")) {
      table.classList.remove("wide");
      const room = table.parentElement?.clientWidth ?? Infinity;
      if (table.offsetWidth > room + 1) table.classList.add("wide");
    }

    const fit = (img: HTMLImageElement) => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      const widest = (MAX_PICTURE_MM * PX_PER_MM * img.naturalWidth) / img.naturalHeight;
      img.style.maxWidth = `${Math.round(widest)}px`;
    };
    const waiting: Array<() => void> = [];
    for (const img of doc.querySelectorAll<HTMLImageElement>(".slide-fig img")) {
      if (img.complete) fit(img);
      else {
        const onLoad = () => fit(img);
        img.addEventListener("load", onLoad, { once: true });
        waiting.push(() => img.removeEventListener("load", onLoad));
      }
    }
    return () => waiting.forEach((off) => off());
  }, [watch]);
  return null;
}
