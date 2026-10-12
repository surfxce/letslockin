"use client";

import { useEffect, useRef, useState } from "react";

/** A button with a popover that closes on outside click or Escape. */
export function Menu({
  label,
  children,
  align = "left",
  buttonClassName = "chip-btn",
  title,
}: {
  label: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  buttonClassName?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        type="button"
        className={buttonClassName}
        aria-expanded={open}
        aria-haspopup="menu"
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div className={`popover ${align === "right" ? "right" : ""}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
