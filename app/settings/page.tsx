import { AutoFlashcardsToggle } from "@/app/ak/DeckControls";
import Link from "next/link";

import { AppUpdate } from "@/app/settings/AppUpdate";
import { CloudSettings } from "@/app/settings/CloudSettings";
import { LaqSettings, ModePicker, NotifyToggle } from "@/app/settings/controls";
import { Tag } from "@/app/ui/bits";
import { Icon } from "@/app/ui/Icon";
import { ModelPicker } from "@/app/ui/ModelPicker";
import { prisma } from "@/lib/db";
import { plural, tagTone } from "@/lib/format";
import { detectAntigravity, detectCli, detectCodex } from "@/lib/llm/detect";
import { findModel } from "@/lib/llm/catalog";
import { API_SERVICES, CLOUD_ENGINE_LABEL, CLOUD_MODEL_LABEL, usesAi } from "@/lib/modes";
import { modelsPayload } from "@/lib/payloads";
import { getApiKey, getSettings, readHeartbeat } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, cli, codex, agy, apiKey, beat, models, courses] = await Promise.all([
    getSettings(),
    detectCli(),
    detectCodex(),
    detectAntigravity(),
    getApiKey(),
    readHeartbeat(),
    modelsPayload(),
    prisma.course.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { lectures: true } } } }),
  ]);
  const linked = findModel(models.active);
  // The fallback is the model chosen for local mode, else any that is downloaded.
  const offline = linked ?? models.installed.map((m) => findModel(m.id)).find(Boolean) ?? null;
  // What the chosen cloud AI is, for the Automatic choice and the worker line.
  const engine = (() => {
    const label = CLOUD_ENGINE_LABEL[settings.cloudEngine];
    switch (settings.cloudEngine) {
      case "codex":
        return { label, ready: codex.found, detail: codex.found ? settings.codexModel || null : "not found" };
      case "antigravity":
        return { label, ready: agy.found, detail: agy.found ? settings.agyModel || null : "not found" };
      case "api": {
        const anthropic = settings.apiService === "anthropic";
        const ready = (!!apiKey || settings.apiService === "custom") && (anthropic || !!settings.apiModel);
        const service = API_SERVICES[settings.apiService].label;
        const model = anthropic ? CLOUD_MODEL_LABEL[settings.cloudModel] : settings.apiModel;
        return { label: service, ready, detail: ready ? model : "needs a key and a model" };
      }
      default:
        return { label, ready: cli.found, detail: cli.found ? CLOUD_MODEL_LABEL[settings.cloudModel] : "not found" };
    }
  })();
  const worker = settings.mode === "local" ? (linked?.name ?? "no model yet") : `${engine.label}${engine.detail && engine.ready ? ` · ${engine.detail}` : ""}`;

  return (
    <main className="page narrow">
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Everything stays on this computer. <a href="#intro">See how Lockin works again</a>.
      </p>

      <h2>Summaries and LAQs</h2>
      <ModePicker mode={settings.mode} engine={engine} localModel={linked?.name ?? null} />
      {settings.mode === "auto" && (
        <CloudSettings
          engine={settings.cloudEngine}
          cloudModel={settings.cloudModel}
          fallbackLocal={settings.fallbackLocal}
          offlineModel={offline?.name ?? null}
          codexModel={settings.codexModel}
          agyModel={settings.agyModel}
          apiService={settings.apiService}
          apiBaseUrl={settings.apiBaseUrl}
          apiModel={settings.apiModel}
          apiVision={settings.apiVision}
          apiKeySaved={apiKey ? `…${apiKey.slice(-4)}` : null}
          tools={{ claude: cli, codex, antigravity: agy }}
        />
      )}
      {usesAi(settings.mode) && (
        <div className="setting">
          <div>
            <div className="st">AI worker</div>
            <div className="sd">
              {beat?.alive ? (
                <>
                  Running on <code>{worker}</code> — prepares one lecture at a time, and marks answers first.
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

      <h2 id="laqs">LAQs</h2>
      <LaqSettings
        laqsPerHour={settings.laqsPerHour}
        sittingPerHour={settings.sittingPerHour}
        laqStyle={settings.laqStyle}
      />

      <h2 id="ak">AK · Anki Killer</h2>
      <AutoFlashcardsToggle enabled={settings.autoFlashcards} />

      <h2 id="local">Offline AI on this computer</h2>
      <p className="muted small" style={{ marginTop: -4 }}>
        Download a model once and Lockin works with no internet. The middle one is chosen for this computer; downloading
        any of them switches Lockin to it when it finishes.
      </p>
      <ModelPicker initial={models} showInstalled />

      <AppUpdate />

      <h2>Getting started</h2>
      <div className="setting">
        <div>
          <div className="st">Onboarding</div>
          <div className="sd">The walkthrough from the first time you opened Lockin: adding lectures, choosing the AI, practising and reminders.</div>
        </div>
        <a href="#intro" className="btn">
          <Icon name="refresh" size={14} /> Repeat onboarding
        </a>
      </div>

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
