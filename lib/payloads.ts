import { findModel, LOCAL_MODELS, recommendModels, type LocalModel, type MachineSpecs, type ModelPicks } from "@/lib/llm/catalog";
import { activity, type Activity } from "@/lib/jobs";
import { downloads, installedModels, type DownloadState } from "@/lib/models";
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
  installed: Array<{ id: string; bytes: number }>;
  /** The model local mode is linked to, when it is downloaded. */
  active: string | null;
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
    installed: installed.map((m) => ({ id: m.id, bytes: m.bytes })),
    active: installed.some((m) => m.id === settings.localModel) ? settings.localModel : null,
    mode: settings.mode,
    downloads: dls,
    workerAlive: !!beat?.alive,
  };
}
