import { prisma } from "@/lib/db";
import { CLOUD_MODELS, LAQ_STYLES, perHour, type CloudModel, type LaqStyle, type Mode } from "@/lib/modes";

export type { CloudModel, LaqStyle, Mode } from "@/lib/modes";

export interface Settings {
  mode: Mode;
  /** Desktop notifications when a lecture's LAQs are due. */
  notify: boolean;
  /** The first-run walkthrough has been seen. */
  onboarded: boolean;
  /** Catalog id of the downloaded model used in "local" mode. */
  localModel: string | null;
  /** LAQs written per hour of lecture, when it is prepared and on "Write new LAQs". */
  laqsPerHour: number;
  /** LAQs a sitting asks per hour of lecture. */
  sittingPerHour: number;
  /** How LAQs are asked: as a scenario, straight to the point, or a mix. */
  laqStyle: LaqStyle;
  /** Which Claude prepares lectures and marks in "auto" mode. */
  cloudModel: CloudModel;
  /** When Claude fails, do the job on the downloaded offline model instead, if there is one. */
  fallbackLocal: boolean;
}

const DEFAULTS: Settings = {
  mode: "auto",
  notify: false,
  onboarded: false,
  localModel: null,
  laqsPerHour: 2,
  sittingPerHour: 2,
  laqStyle: "mixed",
  cloudModel: "sonnet",
  fallbackLocal: true,
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
  return out;
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  const json = JSON.stringify(value);
  await prisma.setting.upsert({ where: { key }, update: { value: json }, create: { key, value: json } });
}

/** Written by the worker on every loop, so the UI can tell a stalled queue from an idle one. */
export const HEARTBEAT_KEY = "worker.heartbeat";

export interface Heartbeat {
  at: string;
  pid: number;
  provider: string;
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
