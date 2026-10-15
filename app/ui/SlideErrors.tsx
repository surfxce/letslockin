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
      let why = "";
      try {
        const res = await fetch(img.src, { cache: "no-store" });
        if (!res.ok) why = (await res.text()).trim();
      } catch {
        why = "Lockin's server didn't answer.";
      }
      (img.closest(".slide-shot") ?? img.closest("a"))?.remove();
      const caption = figure.querySelector("figcaption");
      if (caption && !caption.querySelector(".slide-error")) {
        const note = document.createElement("span");
        note.className = "slide-error";
        note.textContent = ` — couldn't show this slide${why ? `: ${why}` : ""}`;
        caption.append(note);
      }
      if (!figure.querySelector("img")) figure.classList.add("missing");
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
