import { prisma } from "@/lib/db";
import { markingPrompt } from "@/lib/offline";
import { questionNumbers } from "@/lib/views";

export const dynamic = "force-dynamic";

/** A marking prompt for a sitting answered in the app, for copy-and-paste mode. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const attempt = await prisma.attempt.findUnique({
    where: { id },
    include: { lecture: { select: { title: true } }, responses: { include: { question: true } } },
  });
  if (!attempt) return new Response("No such sitting.", { status: 404 });

  const numbers = await questionNumbers(attempt.lectureId);
  const items = attempt.responses
    .filter((r) => r.answerText.trim())
    .map((r) => {
      let rubric = null;
      try {
        rubric = JSON.parse(r.question.rubric);
      } catch {
        // An unreadable rubric just means the chat marks without a guide.
      }
      return { number: numbers.get(r.questionId) ?? 0, stem: r.question.stem, rubric, answer: r.answerText };
    })
    .sort((a, b) => a.number - b.number);

  return new Response(markingPrompt({ lectureTitle: attempt.lecture.title, items }), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
