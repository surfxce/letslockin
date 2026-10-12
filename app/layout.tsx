import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

import type { StatusPayload } from "@/app/api/status/route";
import { Icon } from "@/app/ui/Icon";
import { NavLinks } from "@/app/ui/NavLinks";
import { Onboarding } from "@/app/ui/Onboarding";
import { StatusBar } from "@/app/ui/StatusBar";
import { prisma } from "@/lib/db";
import { activity } from "@/lib/jobs";
import { detectCli } from "@/lib/llm/detect";
import { getSettings } from "@/lib/settings";
import { dueLectures } from "@/lib/views";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lockin",
  description: "Lectures in, exam practice out.",
};

/** Marks the desktop app before first paint, so the top bar clears macOS's window buttons. */
const DESKTOP_SCRIPT = `if (window.lockin && window.lockin.desktop) document.documentElement.classList.add("desktop");`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [settings, act, due, courses, cli] = await Promise.all([
    getSettings(),
    activity(),
    dueLectures(),
    prisma.course.count(),
    detectCli(),
  ]);
  const status: StatusPayload = {
    ...act,
    mode: settings.mode,
    notify: settings.notify,
    due: due.map((d) => ({
      lectureId: d.id,
      title: d.title,
      courseCode: d.courseCode,
      dueAt: d.dueAt!,
      lastScore: d.lastScore,
    })),
  };

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: DESKTOP_SCRIPT }} />
      </head>
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-mark">L</span> Lockin
          </Link>
          <NavLinks />
          <span className="spacer" />
          <StatusBar initial={status} />
          <a href="#intro" className="icon-btn" title="How Lockin works">
            <Icon name="help" size={17} />
          </a>
        </header>
        {children}
        <Onboarding
          firstRun={!settings.onboarded}
          cliFound={cli.found}
          hasCourses={courses > 0}
          mode={settings.mode}
          notify={settings.notify}
        />
      </body>
    </html>
  );
}
