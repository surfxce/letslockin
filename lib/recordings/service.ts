import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { CloudError } from "@/lib/llm/base";
import { throwIfCancelled } from "@/lib/llm/cancel";
import type { LlmProvider } from "@/lib/llm/provider";
import { checksum } from "@/lib/parse";
import { materialsDir } from "@/lib/paths";
import { geminiListener, listen, listenerLabel } from "@/lib/recordings/gemini";
import { cutSound, whisper, whisperHelper, WHISPER_MODELS, type AudioPart, type HelperProgress } from "@/lib/recordings/helper";
import { listenableType } from "@/lib/recordings/media";
import { applyFixes, formatTranscript, pieces, vocabulary, type Fix, type Segment } from "@/lib/recordings/transcript";
import { getSettings } from "@/lib/settings";

/** Kinds of file kept as they are; anything else (a video, a big WAV) is cut down to its sound first. */
const COMPACT = new Set([".aac", ".m4a", ".mp3", ".ogg"]);

/** Recordings of a lecture still to be transcribed: none has a transcript made from it,
 *  and the lecture has no transcript of its own (captions beat any speech model). */
export async function untranscribed(lectureId: string) {
  const materials = await prisma.material.findMany({
    where: { lectureId, kind: { in: ["RECORDING", "TRANSCRIPT"] } },
    select: { id: true, kind: true, path: true, originalName: true, checksum: true, sourceId: true, extractedText: true },
    orderBy: { createdAt: "asc" },
  });
  const transcripts = materials.filter((m) => m.kind === "TRANSCRIPT");
  if (transcripts.some((t) => !t.sourceId && t.extractedText?.trim())) return [];
  const done = new Set(transcripts.map((t) => t.sourceId));
  return materials.filter((m) => m.kind === "RECORDING" && !done.has(m.id));
}

const STAGE_WORDS: Record<string, string> = {
  download: "Downloading the speech model (once)",
  load: "Loading the speech model",
  read: "Reading the recording",
  write: "Cutting the recording into parts",
  transcribe: "Listening",
};

function say(report: ((detail: string | null) => void) | undefined) {
  return (p: HelperProgress) => report?.(`${STAGE_WORDS[p.stage] ?? p.stage} · ${Math.round(p.progress * 100)}%`);
}

/** The slides' technical words and the course's concept names: how terms should be spelled. */
async function wordsFor(lectureId: string): Promise<{ title: string; words: string[] }> {
  const lecture = await prisma.lecture.findUniqueOrThrow({
    where: { id: lectureId },
    select: {
      title: true,
      courseId: true,
      materials: { where: { kind: "SLIDES" }, select: { extractedText: true } },
    },
  });
  const concepts = await prisma.concept.findMany({
    where: { courseId: lecture.courseId, mergedIntoId: null },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { name: true },
  });
  const fromSlides = vocabulary(lecture.materials.map((m) => m.extractedText ?? ""), 300);
  const words = [...new Set([...concepts.map((c) => c.name), ...fromSlides])].slice(0, 400);
  return { title: lecture.title, words };
}

/**
 * Turns a lecture's recordings into transcripts, so it can be prepared like any other.
 *
 * When Gemini is the AI in Settings, the sound goes straight to Gemini, which hears it
 * and writes the transcript itself. Otherwise Whisper transcribes it on this Mac (free,
 * offline, a little slow), and the AI — when there is one — reads the transcript beside
 * the slides' words and corrects the technical terms Whisper misheard.
 */
export async function transcribeLecture(
  lectureId: string,
  provider: LlmProvider | null,
  report?: (detail: string | null) => void,
): Promise<{ transcribed: number; via: string[]; fixes: number; notes: string[] }> {
  const recordings = await untranscribed(lectureId);
  const out = { transcribed: 0, via: [] as string[], fixes: 0, notes: [] as string[] };
  if (!recordings.length) return out;
  const settings = await getSettings();
  const { title, words } = await wordsFor(lectureId);
  const helper = whisperHelper();

  for (const recording of recordings) {
    let file = path.join(materialsDir(), recording.path);
    let duration = 0;
    const work = await mkdtemp(path.join(tmpdir(), "lockin-recording-"));
    try {
      // A filmed lecture is mostly picture: keep only its sound, about 15 MB an hour.
      if (helper && !COMPACT.has(path.extname(file).toLowerCase())) {
        report?.("Keeping just the sound");
        const { parts, duration: seconds } = await cutSound(file, work, 100_000, say(report));
        const compact = recording.path.replace(/\.[^./]+$/, "") + ".aac";
        await rename(parts[0].path, path.join(materialsDir(), compact));
        await rm(file, { force: true });
        await prisma.material.update({ where: { id: recording.id }, data: { path: compact, durationSec: seconds } });
        file = path.join(materialsDir(), compact);
        duration = seconds;
      }
      throwIfCancelled();

      let segments: Segment[] | null = null;
      let madeBy = "";
      const listener = provider ? await geminiListener() : null;
      if (listener) {
        try {
          let parts: Array<AudioPart & { mime: string }>;
          if (helper) {
            const cut = await cutSound(file, path.join(work, "parts"), 20, say(report));
            duration = cut.duration;
            parts = cut.parts.map((p) => ({ ...p, mime: "audio/aac" }));
          } else {
            const mime = listenableType(file);
            if (!mime) throw new CloudError("this kind of recording needs the transcription helper to be sent to Gemini");
            parts = [{ path: file, start: 0, duration: 0, mime }];
          }
          report?.(`Gemini is listening${parts.length > 1 ? ` · part 1 of ${parts.length}` : ""}`);
          const heard = await listen(parts, { title, vocabulary: words.slice(0, 250) }, listener, (n) =>
            report?.(n < parts.length ? `Gemini is listening · part ${n + 1} of ${parts.length}` : "Gemini has heard it all"),
          );
          segments = heard.segments;
          madeBy = listenerLabel(listener);
        } catch (err) {
          if (!(err instanceof CloudError) || !helper) throw err;
          out.notes.push(`Gemini couldn't transcribe it (${err.message}), so Whisper did.`);
        }
      }

      if (!segments) {
        if (!helper) {
          throw new Error(
            "transcribing a recording needs Whisper, which comes with the Mac app — download the latest Lockin.dmg, or choose Gemini as your AI in Settings",
          );
        }
        const model = WHISPER_MODELS[settings.whisperModel];
        const heard = await whisper(file, { model: settings.whisperModel, prompt: words.slice(0, 40).join(", ") }, say(report));
        segments = heard.segments;
        duration = heard.duration || duration;
        madeBy = `Whisper (${model.label.toLowerCase()})`;
      }
      throwIfCancelled();
      if (!segments.length) throw new Error(`no speech was heard in ${recording.originalName}`);

      let text = formatTranscript(segments);
      if (madeBy.startsWith("Whisper") && provider) {
        // The AI reads it in pieces beside the slides' words and lists what was misheard.
        const fixes: Fix[] = [];
        const chunks = pieces(text, provider.name.startsWith("local") ? 9_000 : 40_000);
        try {
          for (const [i, chunk] of chunks.entries()) {
            report?.(`Checking technical words${chunks.length > 1 ? ` · part ${i + 1} of ${chunks.length}` : ""}`);
            fixes.push(...(await provider.fixTranscript({ title, vocabulary: words, transcript: chunk })).fixes);
            throwIfCancelled();
          }
          const fixed = applyFixes(text, fixes);
          text = fixed.text;
          out.fixes += fixed.applied;
          madeBy += `, checked by ${provider.lastModel}`;
        } catch (err) {
          if (jobWasCancelled(err)) throw err;
          out.notes.push(`The technical words weren't checked: ${err instanceof Error ? err.message : err}`);
        }
      }

      const transcriptPath = path.join(lectureId, `${recording.checksum}_transcript.txt`);
      await writeFile(path.join(materialsDir(), transcriptPath), text);
      await prisma.$transaction([
        prisma.material.create({
          data: {
            lectureId,
            kind: "TRANSCRIPT",
            path: transcriptPath,
            originalName: `${recording.originalName.replace(/\.[^.]+$/, "")} (transcript)`,
            extractedText: text,
            checksum: checksum(Buffer.from(text)),
            sourceId: recording.id,
            madeBy,
          },
        }),
        prisma.material.update({ where: { id: recording.id }, data: { durationSec: duration || null } }),
      ]);
      // The recording's length sets the lecture's, unless it was given one (1 hour is the default).
      const lecture = await prisma.lecture.findUnique({ where: { id: lectureId }, select: { durationHours: true } });
      if (lecture && lecture.durationHours === 1 && duration > 0) {
        await prisma.lecture.update({ where: { id: lectureId }, data: { durationHours: Math.max(0.5, Math.round((duration / 3600) * 2) / 2) } });
      }
      out.transcribed++;
      out.via.push(madeBy);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  report?.(null);
  return out;
}

/** How a recording added now would be transcribed, in a few words for the page. */
export async function transcribeVia(): Promise<string> {
  const s = await getSettings();
  if (await geminiListener().catch(() => null)) return "Gemini will listen to it and write the transcript";
  if (!whisperHelper()) return "it'll be transcribed once you install the latest Lockin.dmg, which comes with Whisper";
  if (s.mode === "manual") return "Whisper on this Mac will transcribe it";
  return "Whisper on this Mac will transcribe it, then your AI corrects the technical words";
}

const jobWasCancelled = (err: unknown) => err instanceof Error && err.name === "JobCancelled";

/** Queues transcription on its own, for a lecture that isn't being prepared (or with no AI). */
export async function queueTranscribe(lectureId: string) {
  const busy = await prisma.job.findFirst({
    where: { lectureId, kind: { in: ["TRANSCRIBE", "PREPARE"] }, status: { in: ["PENDING", "RUNNING"] } },
    select: { id: true },
  });
  if (busy) return busy.id;
  return (await enqueue("TRANSCRIBE", { lectureId }, lectureId)).id;
}
