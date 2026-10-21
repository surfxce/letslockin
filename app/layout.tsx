import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import "./globals.css";

import { Icon } from "@/app/ui/Icon";
import { NavLinks } from "@/app/ui/NavLinks";
import { Onboarding } from "@/app/ui/Onboarding";
import { StatusBar } from "@/app/ui/StatusBar";
import { prisma } from "@/lib/db";
import { detectCli } from "@/lib/llm/detect";
import { modelsPayload, statusPayload } from "@/lib/payloads";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lockin",
  description: "Lectures in, exam practice out.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [settings, status, courses, cli, models, head] = await Promise.all([
    getSettings(),
    statusPayload(),
    prisma.course.count(),
    detectCli(),
    modelsPayload(),
    headers(),
  ]);
  // The desktop app hides its title bar on macOS, so the top bar must clear the
  // window buttons. Its user agent says so; marking it here avoids a flash.
  const ua = head.get("user-agent") ?? "";
  const macDesktop = ua.includes("Electron/") && ua.includes("Macintosh");

  return (
    <html lang="en" className={macDesktop ? "desktop" : undefined} suppressHydrationWarning>
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-mark">L</span> Lockin
          </Link>
          <NavLinks />
          <span className="spacer" />
          <StatusBar initial={status} />
          <Link href="/settings" className="icon-btn" title="Settings" aria-label="Settings">
            <Icon name="gear" size={18} />
          </Link>
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
          models={models}
        />
      </body>
    </html>
  );
}
