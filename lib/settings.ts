import { prisma } from "@/lib/db";
import {
  API_SERVICE_LIST,
  CLOUD_ENGINES,
  CLOUD_MODELS,
  LAQ_STYLES,
  perHour,
  type ApiService,
  type CloudEngine,
  type CloudModel,
  type LaqStyle,
  type Mode,
  type WhisperChoice,
} from "@/lib/modes";

export type { ApiService, CloudEngine, CloudModel, LaqStyle, Mode } from "@/lib/modes";

export interface Settings {
  /** Independently queue an AK deck when preparing a lecture. Opt-in. */
  autoFlashcards: boolean;
  mode: Mode;
  /** Desktop notifications when a lecture's LAQs are due. */
  notify: boolean;
  /** The first-run walkthrough has been seen. */
  onboarded: boolean;
  /** Catalog id of the downloaded model used in "local" mode. */
  localModel: string | null;
  /** A separate model, on MLX, that looks at the slides for `localModel`; null when it looks itself. */
  slideReader: string | null;
  /** LAQs written per hour of lecture, when it is prepared and on "Write new LAQs". */
  laqsPerHour: number;
  /** LAQs a sitting asks per hour of lecture. */
  sittingPerHour: number;
  /** How LAQs are asked: as a scenario, straight to the point, or a mix. */
  laqStyle: LaqStyle;
  /** Which Claude prepares lectures and marks in "auto" mode. */
  cloudModel: CloudModel;
  /** When the cloud AI fails, do the job on the downloaded offline model instead, if there is one. */
  fallbackLocal: boolean;
  /** Which cloud AI "auto" mode uses. */
  cloudEngine: CloudEngine;
  /** Codex's model; empty for whatever Codex is set to use. */
  codexModel: string;
  /** Antigravity's model; empty for its own choice. */
  agyModel: string;
  /** What the API key is for. Claude on the API uses `cloudModel`. */
  apiService: ApiService;
  /** For "custom": the service's address, ending in /v1 or similar. */
  apiBaseUrl: string;
  /** For services other than Anthropic: the model name. */
  apiModel: string;
  /** The API model takes images, so it is shown the slides as pictures. */
  apiVision: boolean;
  /** How long the Today plan fills, in minutes. */
  dailyMinutes: number;
  /** Which Whisper model transcribes recordings when Gemini isn't the AI. */
  whisperModel: WhisperChoice;
  /** The voice that reads the viva examiner's lines (lib/voice/choice.ts). */
  vivaVoice: string;
}

const DEFAULTS: Settings = {
  autoFlashcards: false,
  mode: "auto",
  notify: false,
  onboarded: false,
  localModel: null,
  slideReader: null,
  laqsPerHour: 2,
  sittingPerHour: 2,
  laqStyle: "mixed",
  cloudModel: "sonnet",
  fallbackLocal: true,
  cloudEngine: "claude",
  codexModel: "",
  agyModel: "",
  apiService: "anthropic",
  apiBaseUrl: "",
  apiModel: "",
  apiVision: true,
  dailyMinutes: 60,
  whisperModel: "accurate",
  vivaVoice: "auto",
};

export async function getSettings(): Promise<Settings> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: Object.keys(DEFAULTS) } },
  });
  const out: Settings = { ...DEFAULTS };
  for (const row of rows) {
    try {
      (out as unknown as Record<string, unknown>)[row.key] = JSON.parse(row.value);
    } catch {
      // A hand-edited or half-written value falls back to the default.
    }
  }
  out.laqsPerHour = perHour(out.laqsPerHour, DEFAULTS.laqsPerHour);
  out.sittingPerHour = perHour(out.sittingPerHour, DEFAULTS.sittingPerHour);
  if (!LAQ_STYLES.includes(out.laqStyle)) out.laqStyle = DEFAULTS.laqStyle;
  if (!CLOUD_MODELS.includes(out.cloudModel)) out.cloudModel = DEFAULTS.cloudModel;
  out.fallbackLocal = out.fallbackLocal !== false;
  if (!CLOUD_ENGINES.includes(out.cloudEngine)) out.cloudEngine = DEFAULTS.cloudEngine;
  if (!API_SERVICE_LIST.includes(out.apiService)) out.apiService = DEFAULTS.apiService;
  for (const k of ["codexModel", "agyModel", "apiBaseUrl", "apiModel"] as const) {
    if (typeof out[k] !== "string") out[k] = "";
  }
  out.autoFlashcards = out.autoFlashcards === true;
  out.apiVision = out.apiVision !== false;
  if (typeof out.slideReader !== "string") out.slideReader = null;
  if (out.whisperModel !== "fast") out.whisperModel = "accurate";
  if (typeof out.vivaVoice !== "string" || !out.vivaVoice) out.vivaVoice = "auto";
  out.dailyMinutes = Number.isFinite(out.dailyMinutes) ? Math.min(600, Math.max(10, Math.round(out.dailyMinutes))) : DEFAULTS.dailyMinutes;
  return out;
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  const json = JSON.stringify(value);
  await prisma.setting.upsert({ where: { key }, update: { value: json }, create: { key, value: json } });
}

/**
 * The API key, kept apart from the other settings so it is never handed to a page:
 * pages are told only whether there is one.
 */
const API_KEY = "apiKey";

export async function getApiKey(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: API_KEY } });
  try {
    const key = row ? JSON.parse(row.value) : null;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

export async function setApiKey(key: string | null) {
  if (!key) {
    await prisma.setting.deleteMany({ where: { key: API_KEY } });
    return;
  }
  const value = JSON.stringify(key);
  await prisma.setting.upsert({ where: { key: API_KEY }, update: { value }, create: { key: API_KEY, value } });
}

/** Written by the worker on every loop, so the UI can tell a stalled queue from an idle one. */
export const HEARTBEAT_KEY = "worker.heartbeat";

export interface Heartbeat {
  at: string;
  pid: number;
  provider: string;
  /** "swift" when the native macOS app owns the queue; omitted by the Electron worker. */
  app?: string;
}

/** The worker counts as running if it has checked in within this window. */
export const HEARTBEAT_STALE_MS = 20_000;

export async function readHeartbeat(): Promise<(Heartbeat & { alive: boolean }) | null> {
  const row = await prisma.setting.findUnique({ where: { key: HEARTBEAT_KEY } });
  if (!row) return null;
  try {
    const beat = JSON.parse(row.value) as Heartbeat;
    return { ...beat, alive: Date.now() - new Date(beat.at).getTime() < HEARTBEAT_STALE_MS };
  } catch {
    return null;
  }
}
