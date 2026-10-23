"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "@/app/ui/Icon";

export function NavLinks() {
  const path = usePathname();
  const on = (prefix: string) => (prefix === "/" ? path === "/" || path.startsWith("/lectures") : path.startsWith(prefix));
  return (
    <nav className="nav">
      <Link href="/today" className={on("/today") ? "on" : undefined}>
        <Icon name="calendar" size={15} /> Today
      </Link>
      <Link href="/" className={on("/") ? "on" : undefined}>
        <Icon name="list" size={15} /> Lectures
      </Link>
      <Link href="/ak" title="Anki Killer" className={on("/ak") ? "on" : undefined}>
        <Icon name="layers" size={15} /> AK
      </Link>
      <Link href="/exam" className={on("/exam") ? "on" : undefined}>
        <Icon name="target" size={15} /> Exam
      </Link>
      <Link href="/progress" className={on("/progress") ? "on" : undefined}>
        <Icon name="trend" size={15} /> Progress
      </Link>
    </nav>
  );
}
