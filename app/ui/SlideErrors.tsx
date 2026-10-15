"use client";

import { useEffect } from "react";

/**
 * A slide picture that fails to load says why, in its caption, instead of showing a
 * broken image — the server's reason ("That slide could not be drawn.") is what makes
 * a problem on one computer diagnosable. Summaries are static HTML, so this looks for
 * failed pictures after they render rather than through an onerror attribute.
 */
export function SlideErrors({ watch }: { watch: string }) {
  useEffect(() => {
    const fail = async (img: HTMLImageElement) => {
      const figure = img.closest("figure");
      if (!figure || img.dataset.failed) return;
      img.dataset.failed = "1";
      const src = img.src;
      // Swap the picture for a note at once — a PDF being printed right now must not
      // show a broken image — then add the server's reason when it comes.
      (img.closest(".slide-shot") ?? img.closest("a") ?? img).remove();
      if (!figure.querySelector("img")) figure.classList.add("missing");
      const caption = figure.querySelector("figcaption");
      if (!caption || caption.querySelector(".slide-error")) return;
      const note = document.createElement("span");
      note.className = "slide-error";
      note.textContent = " — couldn't show this slide";
      caption.append(note);
      let why = "";
      try {
        const res = await fetch(src, { cache: "no-store" });
        if (!res.ok) why = (await res.text()).trim();
      } catch {
        why = "Lockin's server didn't answer.";
      }
      if (why) note.textContent = ` — couldn't show this slide: ${why}`;
    };
    const imgs = [...document.querySelectorAll<HTMLImageElement>(".slide-fig img")];
    const listeners = imgs.map((img) => {
      const onError = () => void fail(img);
      if (img.complete && img.naturalWidth === 0 && img.src) void fail(img);
      else img.addEventListener("error", onError);
      return () => img.removeEventListener("error", onError);
    });
    return () => listeners.forEach((off) => off());
  }, [watch]);
  return null;
}
