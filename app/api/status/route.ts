import { activity } from "@/lib/jobs";
import { getSettings } from "@/lib/settings";
import { dueLectures } from "@/lib/views";

export const dynamic = "force-dynamic";

export interface DueItem {
  lectureId: string;
  title: string;
  courseCode: string;
  dueAt: string;
  lastScore: number | null;
}

export type StatusPayload = Awaited<ReturnType<typeof activity>> & {
  mode: "auto" | "manual";
  notify: boolean;
  due: DueItem[];
};

/**
 * What the app is doing and what is due. Polled by the header in every window, and
 * by the desktop app's main process for notifications while no window is open.
 */
export async function GET() {
  const [act, settings, due] = await Promise.all([activity(), getSettings(), dueLectures()]);
  const body: StatusPayload = {
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
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
