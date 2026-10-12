import Link from "next/link";

import { ModePicker, NotifyToggle } from "@/app/settings/controls";
import { Tag } from "@/app/ui/bits";
import { Icon } from "@/app/ui/Icon";
import { ModelPicker } from "@/app/ui/ModelPicker";
import { prisma } from "@/lib/db";
import { plural, tagTone } from "@/lib/format";
import { cliConfigFromEnv } from "@/lib/llm/cli";
import { detectCli } from "@/lib/llm/detect";
import { findModel } from "@/lib/llm/catalog";
import { MODE_LABEL, usesAi } from "@/lib/modes";
import { modelsPayload } from "@/lib/payloads";
import { getSettings, readHeartbeat } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, cli, beat, models, courses] = await Promise.all([
    getSettings(),
    detectCli(),
    readHeartbeat(),
    modelsPayload(),
    prisma.course.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { lectures: true } } } }),
  ]);
  const linked = findModel(models.active);
  const engine = settings.mode === "local" ? (linked?.name ?? "no model yet") : cliConfigFromEnv().model;

  return (
    <main className="page narrow">
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Everything stays on this computer. <a href="#intro">See how Lockin works again</a>.
      </p>

      <h2>Summaries and LAQs</h2>
      <ModePicker mode={settings.mode} cliFound={cli.found} cliVersion={cli.version} localModel={linked?.name ?? null} />
      {usesAi(settings.mode) && (
        <div className="setting">
          <div>
            <div className="st">AI worker</div>
            <div className="sd">
              {beat?.alive ? (
                <>
                  Running on {MODE_LABEL[settings.mode]} (<code>{engine}</code>) — prepares one lecture at a time, and
                  marks answers first.
                </>
              ) : (
                <>
                  Not running, so nothing queued will start. The desktop app runs it for you; from the repository,
                  run <code>npm run worker</code> beside <code>npm run dev</code>.
                </>
              )}
            </div>
          </div>
          <Tag tone={beat?.alive ? "green" : "orange"}>{beat?.alive ? "Running" : "Stopped"}</Tag>
        </div>
      )}

      <h2 id="local">Offline AI on this computer</h2>
      <p className="muted small" style={{ marginTop: -4 }}>
        Download a model once and Lockin works with no internet. The middle one is chosen for this computer; downloading
        any of them switches Lockin to it when it finishes.
      </p>
      <ModelPicker initial={models} showInstalled />

      <h2>Reminders</h2>
      <NotifyToggle enabled={settings.notify} />

      <h2>Courses</h2>
      <div className="files">
        {courses.map((c) => (
          <div key={c.id} className="file" style={{ alignItems: "center" }}>
            <Tag tone={tagTone(c.code)}>{c.code}</Tag>
            <span style={{ flex: 1 }}>
              {c.title} <span className="small muted">· {plural(c._count.lectures, "lecture")}</span>
            </span>
            <Link href={`/courses/${c.id}/settings`} className="btn sm">
              <Icon name="gear" size={13} /> Edit
            </Link>
          </div>
        ))}
      </div>
      <p>
        <Link href="/courses/new" className="btn">
          <Icon name="plus" /> New course
        </Link>
      </p>
    </main>
  );
}
