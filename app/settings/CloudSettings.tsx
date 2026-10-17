"use client";

import { useState, useTransition } from "react";

import { saveApiKey, setCloudSettings, setEngineSettings, testCloudEngine } from "@/app/study-actions";
import { Icon } from "@/app/ui/Icon";
import {
  API_SERVICE_LIST,
  API_SERVICES,
  CLOUD_ENGINE_LABEL,
  CLOUD_ENGINES,
  CLOUD_MODEL_LABEL,
  CLOUD_MODELS,
  type ApiService,
  type CloudEngine,
  type CloudModel,
} from "@/lib/modes";

interface Tool {
  found: boolean;
  version: string | null;
  binary: string;
}

/** The cloud AI "auto" mode runs on, how it is set up, and what happens when it fails. */
export function CloudSettings(props: {
  engine: CloudEngine;
  cloudModel: CloudModel;
  fallbackLocal: boolean;
  offlineModel: string | null;
  codexModel: string;
  agyModel: string;
  apiService: ApiService;
  apiBaseUrl: string;
  apiModel: string;
  apiVision: boolean;
  /** The end of the saved key ("…a1b2"), never the key; null when there is none. */
  apiKeySaved: string | null;
  tools: Record<"claude" | "codex" | "antigravity", Tool>;
}) {
  const [engine, setEngine] = useState(props.engine);
  const [model, setModel] = useState(props.cloudModel);
  const [service, setService] = useState(props.apiService);
  const [fallback, setFallback] = useState(props.fallbackLocal);
  const [vision, setVision] = useState(props.apiVision);
  const [key, setKey] = useState("");
  const [keyNote, setKeyNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | "running" | null>(null);
  const [, start] = useTransition();

  const save = (patch: Parameters<typeof setEngineSettings>[0]) => {
    setTest(null);
    start(() => setEngineSettings(patch));
  };
  const blurb: Record<CloudModel, string> = {
    sonnet: "Fast and thorough — the right size for summaries, LAQs and marking.",
    opus: "The most thorough, and the slowest: a lecture takes noticeably longer.",
    haiku: "The quickest and lightest. Fine for short lectures; less depth in summaries.",
  };
  const claudeModels = (
    <div className="seg" role="radiogroup" aria-label="Claude model">
      {CLOUD_MODELS.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={model === m}
          className={model === m ? "on" : undefined}
          onClick={() => {
            setModel(m);
            setTest(null);
            start(() => setCloudSettings({ cloudModel: m }));
          }}
        >
          {CLOUD_MODEL_LABEL[m]}
          {m === "sonnet" && <span className="faint"> · default</span>}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="setting" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="st">Cloud AI</div>
          <div className="sd">Which AI prepares lectures, writes LAQs and marks. Each uses your own sign-in or key.</div>
        </div>
        <div className="seg" role="radiogroup" aria-label="Cloud AI">
          {CLOUD_ENGINES.map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={engine === e}
              className={engine === e ? "on" : undefined}
              onClick={() => {
                setEngine(e);
                save({ cloudEngine: e });
              }}
            >
              {CLOUD_ENGINE_LABEL[e]}
            </button>
          ))}
        </div>
      </div>

      <div className="engine-panel">
        {engine === "claude" && (
          <>
            <ToolStatus
              tool={props.tools.claude}
              name="Claude Code"
              install={
                <>
                  Install it with <code>npm i -g @anthropic-ai/claude-code</code>, then run <code>claude</code> once to
                  sign in with your Claude plan.
                </>
              }
            />
            <div className="engine-row">
              <span className="small muted">{blurb[model]}</span>
              {claudeModels}
            </div>
          </>
        )}

        {engine === "codex" && (
          <>
            <ToolStatus
              tool={props.tools.codex}
              name="Codex"
              install={
                <>
                  Install it with <code>npm i -g @openai/codex</code>, then run <code>codex login</code> once to sign in
                  with your ChatGPT plan.
                </>
              }
            />
            <p className="small muted">Uses your ChatGPT plan. It sees the slides as pictures.</p>
            <TextSetting
              label="Model"
              initial={props.codexModel}
              placeholder="Codex's default"
              hint="Leave empty for the model Codex is set to use."
              onSave={(v) => save({ codexModel: v })}
            />
          </>
        )}

        {engine === "antigravity" && (
          <>
            <ToolStatus
              tool={props.tools.antigravity}
              name={props.tools.antigravity.binary === "gemini" ? "Gemini CLI" : "Antigravity CLI"}
              install={
                <>
                  Install the Antigravity CLI from <code>antigravity.google/cli</code>, then run <code>agy</code> once to
                  sign in with your Google account. The older Gemini CLI (<code>gemini</code>) works too.
                </>
              }
            />
            <p className="small muted">Uses your Google account. Gemini reads the slide PDFs itself.</p>
            <TextSetting
              label="Model"
              initial={props.agyModel}
              placeholder="auto"
              hint="Leave empty to let it choose."
              onSave={(v) => save({ agyModel: v })}
            />
          </>
        )}

        {engine === "api" && (
          <>
            <label className="engine-row">
              <span className="small">Service</span>
              <select
                value={service}
                onChange={(e) => {
                  const next = e.target.value as ApiService;
                  setService(next);
                  save({ apiService: next });
                }}
                style={{ width: "auto" }}
              >
                {API_SERVICE_LIST.map((s) => (
                  <option key={s} value={s}>
                    {API_SERVICES[s].label}
                  </option>
                ))}
              </select>
            </label>
            {service === "anthropic" ? (
              <div className="engine-row">
                <span className="small muted">Billed per use to your Anthropic account. {blurb[model]}</span>
                {claudeModels}
              </div>
            ) : (
              <>
                {service === "custom" && (
                  <TextSetting
                    label="Address"
                    initial={props.apiBaseUrl}
                    placeholder="http://localhost:11434/v1"
                    hint="Any service that speaks OpenAI's chat format — Ollama, LM Studio, a company endpoint."
                    onSave={(v) => save({ apiBaseUrl: v })}
                  />
                )}
                <TextSetting
                  label="Model"
                  initial={props.apiModel}
                  placeholder="model name"
                  hint={`Required: ${API_SERVICES[service].modelHint}.`}
                  onSave={(v) => save({ apiModel: v })}
                />
                <label className="check" style={{ marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={vision}
                    onChange={(e) => {
                      setVision(e.target.checked);
                      save({ apiVision: e.target.checked });
                    }}
                  />
                  <span>
                    This model can see images
                    <span className="small muted"> — it is shown the slides as pictures. Untick it for a text-only model.</span>
                  </span>
                </label>
              </>
            )}
            <form
              className="engine-row"
              onSubmit={(e) => {
                e.preventDefault();
                start(async () => {
                  setKeyNote(await saveApiKey(key));
                  setKey("");
                });
              }}
            >
              <span className="small">API key</span>
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={props.apiKeySaved ? `Saved (${props.apiKeySaved}) — paste a new one to replace it` : "Paste your key"}
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 200 }}
              />
              <button type="submit" className="btn sm" disabled={!key.trim()}>
                Save key
              </button>
              {props.apiKeySaved && (
                <button
                  type="button"
                  className="btn quiet sm"
                  onClick={() => start(async () => setKeyNote(await saveApiKey(null)))}
                >
                  Remove
                </button>
              )}
            </form>
            <p className="small faint" style={{ margin: "2px 0 0" }}>
              {API_SERVICES[service].keys ? `Get a key at ${API_SERVICES[service].keys}. ` : ""}It stays on this
              computer, in Lockin&apos;s own database.
              {keyNote && <span className={`result ${keyNote.ok ? "ok" : "err"}`}> {keyNote.message}</span>}
            </p>
          </>
        )}

        <div className="engine-row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn sm"
            disabled={test === "running"}
            onClick={() => {
              setTest("running");
              start(async () => setTest(await testCloudEngine()));
            }}
          >
            <Icon name="zap" size={13} /> {test === "running" ? "Asking…" : "Test it"}
          </button>
          {test && test !== "running" && (
            <span className={`result ${test.ok ? "ok" : "err"}`} role="status">
              {test.message}
            </span>
          )}
          {test === null && <span className="small faint">Sends one tiny question, to check it is set up.</span>}
        </div>
      </div>

      <div className="setting">
        <div>
          <div className="st">If the cloud AI fails, use the offline model</div>
          <div className="sd">
            {props.offlineModel
              ? `When ${CLOUD_ENGINE_LABEL[engine]} can't do a job — signed out, over a usage limit, offline — ${props.offlineModel} on this computer does it instead. The cloud AI is always tried first.`
              : `Download an offline model below and Lockin uses it whenever ${CLOUD_ENGINE_LABEL[engine]} can't do a job — signed out, over a usage limit, offline. The cloud AI is always tried first.`}
          </div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={fallback}
            onChange={(e) => {
              setFallback(e.target.checked);
              start(() => setCloudSettings({ fallbackLocal: e.target.checked }));
            }}
            aria-label="Fall back to the offline model"
          />
          <span />
        </label>
      </div>
    </>
  );
}

function ToolStatus({ tool, name, install }: { tool: Tool; name: string; install: React.ReactNode }) {
  return tool.found ? (
    <p className="small" style={{ margin: "0 0 6px" }}>
      <span className="tag t-green">{name} found{tool.version ? ` · ${tool.version}` : ""}</span>
    </p>
  ) : (
    <p className="small" style={{ margin: "0 0 6px" }}>
      <span className="tag t-red">{name} not found</span> <span className="muted">{install}</span>
    </p>
  );
}

/** A text box that saves when you leave it or press Enter. */
function TextSetting({
  label,
  initial,
  placeholder,
  hint,
  onSave,
}: {
  label: string;
  initial: string;
  placeholder: string;
  hint: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const commit = () => {
    if (value.trim() === saved.trim()) return;
    setSaved(value);
    onSave(value);
  };
  return (
    <label className="engine-row">
      <span className="small">{label}</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        style={{ flex: 1, minWidth: 200 }}
      />
      <span className="small faint" style={{ flexBasis: "100%" }}>
        {hint}
      </span>
    </label>
  );
}
