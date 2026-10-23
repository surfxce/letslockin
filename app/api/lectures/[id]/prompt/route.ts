import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { OWN_QUESTIONS } from "@/lib/mixed/schema";
import { questionBudget } from "@/lib/engines/mastery";
import { askPrompt, breakdownPrompt, laqPrompt, summaryPrompt } from "@/lib/offline";
import { lectureDecks, sharingTitles } from "@/lib/slides";
import { getSettings } from "@/lib/settings";
import { lectureSources } from "@/lib/sources";

export const dynamic = "force-dynamic";

/** The text behind a lecture's "Copy prompt" buttons, built fresh from its files. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const kind = request.nextUrl.searchParams.get("kind");
  const lecture = await prisma.lecture.findUnique({
    where: { id },
    include: { materials: true, _count: { select: { questions: { where: OWN_QUESTIONS } } } },
  });
  if (!lecture) return new Response("No such lecture.", { status: 404 });
  const plain = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

  // A question or a passage is asked of the summary alone.
  if (kind === "ask" || kind === "breakdown") {
    if (!lecture.summaryMd?.trim()) return new Response("This lecture has no summary yet.", { status: 409 });
    const text = (request.nextUrl.searchParams.get(kind === "ask" ? "q" : "text") ?? "").trim();
    if (!text) return new Response(kind === "ask" ? "Type a question first." : "Select some text first.", { status: 400 });
    const body =
      kind === "ask"
        ? askPrompt({ lectureTitle: lecture.title, summary: lecture.summaryMd, question: text })
        : breakdownPrompt({ lectureTitle: lecture.title, summary: lecture.summaryMd, selection: text });
    return new Response(body, { headers: plain });
  }

  // Decks first: it counts the pages of any deck imported before counts were kept,
  // which the slide numbering in the text depends on.
  const decks = await lectureDecks(id);
  const materials = await prisma.material.findMany({ where: { lectureId: id } });
  let sources;
  try {
    sources = lectureSources(materials);
  } catch {
    return new Response("Add this lecture's transcript or slides first.", { status: 409 });
  }
  const slides = { decks, sharedWith: await sharingTitles(lecture) };

  const { laqsPerHour, laqStyle } = await getSettings();
  const text =
    kind === "laqs"
      ? laqPrompt({
          count: questionBudget(lecture.durationHours, laqsPerHour),
          firstNumber: lecture._count.questions + 1,
          sources,
          slides,
          style: laqStyle,
        })
      : summaryPrompt({ durationHours: lecture.durationHours, sources, slides });

  return new Response(text, { headers: plain });
}
