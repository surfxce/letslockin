import { mlxAvailable } from "@/lib/llm/mlx";
import { LOCAL_MODELS, type LocalModel, MORE_MODELS, PAIRS, type ModelPair, type MachineSpecs, type ModelPicks, findModel, recommendModels } from "@/lib/llm/catalog";
import { activity, type Activity } from "@/lib/jobs";
import { visionParts } from "@/lib/llm/vision";
import { downloads, installedModels, modelsDir, type DownloadState } from "@/lib/models";
import type { Mode } from "@/lib/modes";
import { getSettings, readHeartbeat } from "@/lib/settings";
import { machineSpecs } from "@/lib/specs";
import { dueLectures } from "@/lib/views";

/**
 * The JSON the client polls. Built here rather than in the route files, because the
 * layout renders the same thing on first paint and Next only allows a route file to
 * export its handlers.
 */

export interface DueItem {
  lectureId: string;
  title: string;
  courseCode: string;
  dueAt: string;
  lastScore: number | null;
}

export type StatusPayload = Activity & {
  mode: Mode;
  notify: boolean;
  due: DueItem[];
  /** The model local mode runs on, or null when none is downloaded and linked. */
  localModel: { id: string; name: string } | null;
  /** Downloads still going, for the top bar. */
  downloading: DownloadState[];
  /** When the server built this (ms), so the first render's elapsed times match on both sides. */
  at: number;
};

export async function statusPayload(): Promise<StatusPayload> {
  const [act, settings, due, installed, dls] = await Promise.all([
    activity(),
    getSettings(),
    dueLectures(),
    installedModels(),
    downloads(),
  ]);
  const linked = installed.some((m) => m.id === settings.localModel) ? findModel(settings.localModel) : undefined;
  return {
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
    localModel: linked ? { id: linked.id, name: linked.name } : null,
    downloading: dls.filter((d) => d.status === "PENDING" || d.status === "RUNNING"),
    at: Date.now(),
  };
}

export interface ModelsPayload {
  specs: MachineSpecs;
  picks: ModelPicks;
  catalog: readonly LocalModel[];
  /** Alternatives and the full list (MLX only). */
  more: readonly LocalModel[];
  /** This computer runs MLX models (Apple Silicon, with the desktop app's engine). */
  mlx: boolean;
  /** vision: the model takes images and can see slides ("ready"), could once its vision
   *  part is downloaded ("missing"), or never can (null). */
  installed: Array<{
    id: string;
    bytes: number;
    vision: "ready" | "missing" | null;
    /** Runs on MLX (the Swift engine) rather than llama.cpp. */
    mlx: boolean;
    /** An MLX copy exists and this Mac can run it, but this install is llama.cpp's. */
    canSwitchToMlx: boolean;
  }>;
  /** The model local mode is linked to, when it is downloaded. */
  active: string | null;
  /** Eye + writer pairs to offer. */
  pairs: readonly ModelPair[];
  /** The separate model chosen to look at the slides for `active`; null when it looks itself. */
  slideReader: string | null;
  mode: Mode;
  downloads: DownloadState[];
  workerAlive: boolean;
}

export async function modelsPayload(): Promise<ModelsPayload> {
  const specs = machineSpecs();
  const [installed, settings, dls, beat] = await Promise.all([
    installedModels(),
    getSettings(),
    downloads(),
    readHeartbeat(),
  ]);
  return {
    specs,
    picks: recommendModels(specs),
    catalog: LOCAL_MODELS,
    more: MORE_MODELS,
    mlx: mlxAvailable(),
    installed: await Promise.all(
      installed.map(async (m) => {
        const model = findModel(m.id);
        const mlx = m.format === "mlx";
        return {
          id: m.id,
          bytes: m.bytes,
          // An MLX copy sees slides with the model itself.
          vision: model?.vision
            ? mlx || (await visionParts(modelsDir(), m.id, m.path))
              ? ("ready" as const)
              : ("missing" as const)
            : null,
          mlx,
          canSwitchToMlx: !mlx && !!model?.mlx && mlxAvailable(),
        };
      }),
    ),
    active: installed.some((m) => m.id === settings.localModel) ? settings.localModel : null,
    pairs: PAIRS,
    slideReader: settings.slideReader,
    mode: settings.mode,
    downloads: dls,
    workerAlive: !!beat?.alive,
  };
}
