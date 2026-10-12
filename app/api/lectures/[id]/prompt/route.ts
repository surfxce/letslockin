import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { questionBudget } from "@/lib/engines/mastery";
import { laqPrompt, summaryPrompt } from "@/lib/offline";
import { lectureSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

/** The text behind a lecture's "Copy prompt" buttons, built fresh from its files. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const kind = request.nextUrl.searchParams.get("kind");
  const lecture = await prisma.lecture.findUnique({
    where: { id },
    include: { materials: true, _count: { select: { questions: true } } },
  });
  if (!lecture) return new Response("No such lecture.", { status: 404 });

  let sources;
  try {
    sources = lectureSources(lecture.materials);
  } catch {
    return new Response("Add this lecture's transcript or slides first.", { status: 409 });
  }

  const text =
    kind === "laqs"
      ? laqPrompt({
          count: questionBudget(lecture.durationHours),
          firstNumber: lecture._count.questions + 1,
          sources,
        })
      : summaryPrompt({ durationHours: lecture.durationHours, sources });

  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
