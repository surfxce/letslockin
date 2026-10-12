"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { deleteLocalModel, downloadModel, stopDownload, switchLocalModel } from "@/app/actions";
import { Icon } from "@/app/ui/Icon";
import type { LocalModel } from "@/lib/llm/catalog";
import type { DownloadState } from "@/lib/models";
import type { ModelsPayload } from "@/lib/payloads";

const SPEED: Record<number, string> = { 5: "Fastest", 4: "Fast", 3: "Steady", 2: "Slower", 1: "Slowest" };

function gb(bytes: number) {
  return bytes < 1024 ** 3 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** "1.7 of 5.0 GB" — short enough to sit beside Cancel. */
function ofTotal(done: number, total: number) {
  const mb = total < 1024 ** 3;
  const size = mb ? 1024 ** 2 : 1024 ** 3;
  const places = mb ? 0 : 1;
  return `${(done / size).toFixed(places)} of ${(total / size).toFixed(places)} ${mb ? "MB" : "GB"}`;
}

/**
 * Three models chosen for this computer — faster on the left, the recommendation in
 * the middle, better on the right. Downloading one links it up when it finishes: it
 * becomes the model Lockin uses, with nothing else to set.
 */
export function ModelPicker({ initial, showInstalled = false }: { initial: ModelsPayload; showInstalled?: boolean }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const wasActive = useRef(initial.downloads.some((d) => d.status === "RUNNING" || d.status === "PENDING"));

  const busy = data.downloads.some((d) => d.status === "RUNNING" || d.status === "PENDING");

  async function refresh() {
    const res = await fetch("/api/models", { cache: "no-store" });
    if (res.ok) setData(await res.json());
  }

  // Follow a download while one runs; when the last one finishes, refresh the page so
  // everything else (the top bar, the mode) catches up with the new model.
  useEffect(() => {
    if (!busy) {
      if (wasActive.current) {
        wasActive.current = false;
        router.refresh();
      }
      return;
    }
    wasActive.current = true;
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [busy, router]);

  const act = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      const result = (await fn()) as { ok?: boolean; message?: string } | undefined;
      if (result && result.ok === false) setError(result.message ?? "Something went wrong.");
      await refresh();
    });

  const { picks, specs } = data;
  const slots: Array<{ role: "performance" | "recommended" | "quality"; label: string; model: LocalModel }> = [
    { role: "performance", label: "Performance", model: picks.performance },
    { role: "recommended", label: "Recommended for you", model: picks.recommended },
    { role: "quality", label: "Quality", model: picks.quality },
  ];

  return (
    <div className="picker">
      <p className="picker-specs">
        <Icon name="cpu" size={14} />
        Your {specs.kind}: {Math.round(specs.ramGb)} GB memory · {specs.cores} cores
        {specs.appleSilicon ? " · Apple Silicon" : ""}
      </p>
      <div className="picker-cards">
        {slots.map(({ role, label, model }) => (
          <ModelCard
            key={role}
            role={role}
            label={label}
            model={model}
            installed={data.installed.find((i) => i.id === model.id)}
            active={data.active === model.id}
            download={data.downloads.find((d) => d.modelId === model.id)}
            otherBusy={busy && !data.downloads.some((d) => d.modelId === model.id && (d.status === "RUNNING" || d.status === "PENDING"))}
            disabled={pending}
            onDownload={() => act(() => downloadModel(model.id))}
            onCancel={(jobId) => act(() => stopDownload(jobId))}
            onUse={() => act(() => switchLocalModel(model.id))}
          />
        ))}
      </div>
      <p className="picker-why">{picks.why}</p>
      {picks.caution && <p className="picker-caution">{picks.caution}</p>}
      {busy && !data.workerAlive && (
        <p className="picker-caution">
          The background worker isn&apos;t running, so the download can&apos;t start. The desktop app runs it; from a
          terminal, run <code>npm run worker</code>.
        </p>
      )}
      {error && <p className="result err">{error}</p>}

      {showInstalled && data.installed.length > 0 && (
        <div className="files" style={{ marginTop: 18 }}>
          {data.installed.map((i) => {
            const model = data.catalog.find((m) => m.id === i.id);
            return (
              <div key={i.id} className="file" style={{ alignItems: "center" }}>
                <Icon name="file" />
                <span style={{ flex: 1 }}>
                  <span className="fname">{model?.name ?? i.id}</span>{" "}
                  <span className="small muted">· {gb(i.bytes)} on disk</span>
                </span>
                {data.active === i.id ? (
                  <span className="tag t-green">In use</span>
                ) : (
                  <button className="btn sm" disabled={pending} onClick={() => act(() => switchLocalModel(i.id))}>
                    Use
                  </button>
                )}
                <button
                  className="btn quiet sm"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(`Delete ${model?.name ?? i.id}? You can download it again later.`)) {
                      act(() => deleteLocalModel(i.id));
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModelCard({
  role,
  label,
  model,
  installed,
  active,
  download,
  otherBusy,
  disabled,
  onDownload,
  onCancel,
  onUse,
}: {
  role: "performance" | "recommended" | "quality";
  label: string;
  model: LocalModel;
  installed?: { bytes: number };
  active: boolean;
  download?: DownloadState;
  otherBusy: boolean;
  disabled: boolean;
  onDownload: () => void;
  onCancel: (jobId: string) => void;
  onUse: () => void;
}) {
  const running = download && (download.status === "RUNNING" || download.status === "PENDING");
  const failed = download?.status === "FAILED" && download.error !== "Cancelled" && !installed;
  const pct = running && download.total > 0 ? Math.min(100, (download.downloaded / download.total) * 100) : 0;

  return (
    <div className={`model-card ${role}${active ? " active" : ""}`}>
      <div className="model-role">
        {role === "performance" && <Icon name="zap" size={12} />}
        {role === "recommended" && <Icon name="check" size={12} />}
        {role === "quality" && <Icon name="sparkles" size={12} />}
        {label}
      </div>
      <div className="model-name">{model.name}</div>
      <div className="model-meta">
        {model.maker} · {model.params}
      </div>
      <div className="model-facts">
        <span>{SPEED[model.speed]}</span>
        <span>~{model.downloadGb} GB download</span>
        <span>needs ~{model.needsRamGb} GB memory</span>
      </div>
      <p className="model-blurb">{model.blurb}</p>

      <div className="model-action">
        {active ? (
          <span className="tag t-green">
            <Icon name="check" size={12} /> Linked — Lockin uses this
          </span>
        ) : installed ? (
          <button className="btn" onClick={onUse} disabled={disabled}>
            Use this model
          </button>
        ) : running ? (
          <div className="model-progress">
            <div className="bar">
              <i className="fill-blue" style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            <div className="row between small muted">
              <span>
                {download.status === "PENDING"
                  ? "Starting…"
                  : download.total
                    ? `${Math.floor(pct)}% · ${ofTotal(download.downloaded, download.total)}`
                    : "Connecting…"}
              </span>
              <button className="btn quiet sm" onClick={() => onCancel(download.jobId)} disabled={disabled}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className={role === "recommended" ? "btn primary" : "btn"}
            onClick={onDownload}
            disabled={disabled || otherBusy}
            title={otherBusy ? "One download at a time" : undefined}
          >
            <Icon name="download" size={14} /> Download
          </button>
        )}
        {failed && <p className="result err" style={{ margin: "6px 0 0" }}>{download!.error}</p>}
      </div>
    </div>
  );
}
