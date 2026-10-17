"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { deleteLocalModel, downloadModel, downloadVision, stopDownload, switchLocalModel, switchToMlx, choosePair } from "@/app/actions";
import { Icon } from "@/app/ui/Icon";
import { parameterCount, type LocalModel } from "@/lib/llm/catalog";
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
  const [alternatives, setAlternatives] = useState(false);
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
      <div className="picker-more">
        <button type="button" className="btn quiet sm" onClick={() => setAlternatives(true)}>
          See alternatives
        </button>
      </div>
      {alternatives && (
        <Alternatives
          data={data}
          slots={slots}
          disabled={pending}
          onDownload={(id) => act(() => downloadModel(id))}
          onUse={(id) => act(() => switchLocalModel(id))}
          onPair={(eye, writer) => act(() => choosePair(eye, writer))}
          onClose={() => setAlternatives(false)}
        />
      )}
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
            const model = [...data.catalog, ...data.more].find((m) => m.id === i.id);
            return (
              <div key={i.id} className="file" style={{ alignItems: "center" }}>
                <Icon name="file" />
                <span style={{ flex: 1 }}>
                  <span className="fname">{model?.name ?? i.id}</span>{" "}
                  <span className="small muted">· {gb(i.bytes)} on disk</span>
                  {i.mlx && (
                    <span className="tag t-purple" style={{ marginLeft: 8 }} title="Runs on Apple's MLX, faster on this Mac than llama.cpp">
                      MLX
                    </span>
                  )}
                  {i.vision === "ready" && (
                    <span className="tag t-blue" style={{ marginLeft: 8 }} title="It is shown each slide before writing the summary">
                      Sees slides
                    </span>
                  )}
                  {data.active === i.id && data.slideReader && data.slideReader !== i.id && (
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      · slides read by {[...data.catalog, ...data.more].find((m) => m.id === data.slideReader)?.name ?? data.slideReader}
                    </span>
                  )}
                </span>
                {i.canSwitchToMlx && (
                  <button
                    className="btn sm"
                    disabled={pending || data.downloads.some((d) => d.modelId === i.id && (d.status === "PENDING" || d.status === "RUNNING"))}
                    title="Downloads its MLX version (about the same size), which runs faster on Apple Silicon and sees slides itself. The llama.cpp copy is removed once it's done."
                    onClick={() => act(() => switchToMlx(i.id))}
                  >
                    Switch to MLX
                  </button>
                )}
                {i.vision === "missing" && !i.canSwitchToMlx && (
                  <button
                    className="btn sm"
                    disabled={pending || data.downloads.some((d) => d.modelId === i.id && (d.status === "PENDING" || d.status === "RUNNING"))}
                    title="Downloads its vision part (under 1 GB) and llama.cpp's server, so it can look at the slides"
                    onClick={() => act(() => downloadVision(i.id))}
                  >
                    Let it see slides
                  </button>
                )}
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

/**
 * Other models beside the three picked for this computer: those that see slides, in the
 * column of the main model each compares with, and — under "Show all" — every model on
 * offer, tiny to enormous, by size. They run on MLX, so only on Apple Silicon.
 */
function Alternatives({
  data,
  slots,
  disabled,
  onDownload,
  onUse,
  onPair,
  onClose,
}: {
  data: ModelsPayload;
  slots: Array<{ role: "performance" | "recommended" | "quality"; label: string; model: LocalModel }>;
  disabled: boolean;
  onDownload: (id: string) => void;
  onUse: (id: string) => void;
  onPair: (eye: string, writer: string) => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  const models = [...data.catalog, ...data.more];
  const byId = (id: string) => models.find((m) => m.id === id)!;
  const eyes = models.filter((m) => m.vision && m.mlx).sort((a, b) => parameterCount(a) - parameterCount(b));
  const [eye, setEye] = useState(data.slideReader ?? (data.active && byId(data.active)?.vision ? data.active : eyes[0].id));
  const [writer, setWriter] = useState(data.active ?? data.picks.recommended.id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const busy = data.downloads.some((d) => d.status === "RUNNING" || d.status === "PENDING");
  const action = (m: LocalModel) => {
    const download = data.downloads.find((d) => d.modelId === m.id && (d.status === "RUNNING" || d.status === "PENDING"));
    if (download) {
      const pct = download.total > 0 ? Math.floor((download.downloaded / download.total) * 100) : 0;
      return <span className="small muted">Downloading {pct}%</span>;
    }
    if (data.active === m.id) return <span className="tag t-green">In use</span>;
    if (data.installed.some((i) => i.id === m.id)) {
      return (
        <button type="button" className="btn sm" disabled={disabled} onClick={() => onUse(m.id)}>
          Use
        </button>
      );
    }
    const tooBig = m.needsRamGb > data.specs.ramGb * 1.25;
    const why = !m.uri && !data.mlx ? "Runs on MLX only, on an Apple Silicon Mac" : tooBig ? `Needs ~${m.needsRamGb} GB of memory` : null;
    return (
      <button
        type="button"
        className="btn sm"
        disabled={disabled || busy || !!why}
        title={why ?? `Download ~${m.downloadGb} GB`}
        onClick={() => onDownload(m.id)}
      >
        <Icon name="download" size={13} /> {why ? (tooBig ? "Too big" : "MLX only") : "Download"}
      </button>
    );
  };

  const label = (m: LocalModel) => (m.name.includes(m.params) ? m.name : `${m.name} · ${m.params}`);
  const everything = [...models].sort((a, b) => parameterCount(a) - parameterCount(b));

  /** For an eye and a writer: in use, downloading, ready to use, or what downloading the missing ones costs. */
  const pairAction = (eyeId: string, writerId: string) => {
    const e = byId(eyeId);
    const w = byId(writerId);
    const same = eyeId === writerId;
    const looking = data.slideReader ?? data.active;
    if (data.active === writerId && looking === eyeId) return <span className="tag t-green">In use</span>;
    const running = data.downloads.filter(
      (d) => (d.modelId === eyeId || d.modelId === writerId) && (d.status === "RUNNING" || d.status === "PENDING"),
    );
    if (running.length) {
      const d = running.find((x) => x.status === "RUNNING") ?? running[0];
      const pct = d.total > 0 ? Math.floor((d.downloaded / d.total) * 100) : 0;
      return <span className="small muted">Downloading {d.name} {pct}%</span>;
    }
    const haveEye = same || data.installed.some((i) => i.id === eyeId && i.mlx);
    const haveWriter = data.installed.some((i) => i.id === writerId);
    const gbToGet = (haveEye ? 0 : e.downloadGb) + (haveWriter ? 0 : w.downloadGb);
    const need = Math.max(e.needsRamGb, w.needsRamGb);
    const why = !same && !data.mlx ? "The eye runs on MLX, on an Apple Silicon Mac" : need > data.specs.ramGb * 1.25 ? `Needs ~${need} GB of memory` : null;
    return (
      <button
        type="button"
        className="btn sm"
        disabled={disabled || (gbToGet > 0 && busy) || !!why}
        title={why ?? (gbToGet > 0 ? `Download ~${Math.round(gbToGet * 10) / 10} GB` : undefined)}
        onClick={() => onPair(eyeId, writerId)}
      >
        {why ? (
          need > data.specs.ramGb * 1.25 ? "Too big" : "MLX only"
        ) : gbToGet > 0 ? (
          <>
            <Icon name="download" size={13} /> Download ~{Math.round(gbToGet * 10) / 10} GB
          </>
        ) : (
          "Use"
        )}
      </button>
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Other models" onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <h2>{all ? "Every model" : "Alternatives"}</h2>
          {!all ? (
            <>
              <p>Other models that see slides, beside each of the three picked for this {data.specs.kind}.</p>
              <div className="alt-columns">
                {slots.map(({ role, label, model }) => {
                  const options = data.more.filter((m) => m.vision && m.like === model.id);
                  return (
                    <div key={role} className="alt-column">
                      <div className="model-role">{role === "recommended" ? "Balanced" : label}</div>
                      <div className="small faint" style={{ marginBottom: 8 }}>
                        like {model.name}
                      </div>
                      {options.length === 0 && <p className="small faint">None at this size yet.</p>}
                      {options.map((m) => (
                        <div key={m.id} className="alt-model">
                          <div className="model-name" style={{ fontSize: 15 }}>
                            {m.name}
                          </div>
                          <div className="small muted">
                            {m.maker} · {m.params} · ~{m.downloadGb} GB
                          </div>
                          {m.blurb && <p className="small" style={{ margin: "4px 0 6px" }}>{m.blurb}</p>}
                          {action(m)}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
              <h3 className="alt-head">Eye + writer</h3>
              <p className="small muted">
                A small model looks at each slide and notes what&apos;s on it; a bigger one writes the summary and LAQs from
                those notes. They take turns, so the memory needed is the larger of the two.
              </p>
              <div className="alt-pairs">
                {data.pairs.map((p) => {
                  const e = byId(p.eye);
                  const w = byId(p.writer);
                  return (
                    <div key={`${p.eye}+${p.writer}`} className="alt-model">
                      <div className="model-name" style={{ fontSize: 15 }}>
                        {e.name} + {w.name}
                      </div>
                      <div className="small muted">
                        eye {e.params} · writer {w.params} · needs ~{Math.max(e.needsRamGb, w.needsRamGb)} GB
                      </div>
                      <p className="small" style={{ margin: "4px 0 6px" }}>{p.blurb}</p>
                      {pairAction(p.eye, p.writer)}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="alt-all">
              {everything.map((m) => (
                <div key={m.id} className="alt-row">
                  <span className="fname">{m.name}</span>
                  <span className="small muted">{m.params}</span>
                  {!m.vision && <span className="small faint">text only</span>}
                  <span className="spacer" />
                  {action(m)}
                </div>
              ))}
            </div>
          )}
          <div className="alt-own">
            <h3 className="alt-head">Separate eye and writer</h3>
            <p className="small muted">Pick your own: any model that sees slides as the eye, any model as the writer.</p>
            <div className="alt-own-row">
              <label>
                <span className="small faint">Eye</span>
                <select value={eye} onChange={(e) => setEye(e.target.value)}>
                  {eyes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {label(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="small faint">Writer</span>
                <select value={writer} onChange={(e) => setWriter(e.target.value)}>
                  {everything.map((m) => (
                    <option key={m.id} value={m.id}>
                      {label(m)}
                      {m.vision ? "" : " · text only"}
                    </option>
                  ))}
                </select>
              </label>
              {pairAction(eye, writer)}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn quiet" onClick={() => setAll(!all)}>
            {all ? "Back to alternatives" : "Show all"}
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
