/**
 * Isolated check of lecture recordings: storing, Whisper with the AI's fixes, Gemini
 * listening (with a stand-in for Google), falling back, and folder import. The Mac
 * helper is played by a small script. Never opens the user's database or calls a real AI.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Plays lockin-whisper: "audio" copies the file into parts, "transcribe" says two things. */
const FAKE_HELPER = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const [cmd, input, out] = process.argv.slice(2);
const opt = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (cmd === "audio") {
  fs.mkdirSync(out, { recursive: true });
  const minutes = Number(opt("--part-minutes"));
  const count = minutes >= 100000 ? 1 : 2;
  const parts = [];
  for (let i = 0; i < count; i++) {
    const p = path.join(out, "part-" + (i + 1) + ".aac");
    fs.copyFileSync(input, p);
    parts.push({ path: p, start: i * 1200, duration: 1200 });
    say({ stage: "write", progress: (i + 1) / count });
  }
  say({ parts, duration: 2400 });
} else if (cmd === "transcribe") {
  console.log("a line of logging that isn't JSON");
  say({ stage: "download", progress: 0.5 });
  say({ stage: "transcribe", progress: 1 });
  if (opt("--model").includes("small")) { say({ error: "the fast model wasn't asked for" }); process.exit(1); }
  say({ segments: [
    { start: 0, end: 5, text: "Today, the glow merula." },
    { start: 50, end: 60, text: "I G A deposits sit in the mesangium." },
    { start: 2390, end: 2399, text: "That's all." }
  ], duration: 2400, model: opt("--model") });
} else { say({ error: "unknown" }); process.exit(1); }
`;

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-recordings-check-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "lockin.db")}`;
  process.env.LOCKIN_DATA_DIR = dir;
  process.env.LOCKIN_PROVIDER = "fake";
  const helper = path.join(dir, "lockin-whisper");
  await writeFile(helper, FAKE_HELPER);
  await chmod(helper, 0o755);
  process.env.LOCKIN_WHISPER = helper;

  const { prisma } = await import("../lib/db");
  const { applyMigrations } = await import("../lib/migrate");
  const { FakeProvider } = await import("../lib/llm/fake");
  const { setSetting, setApiKey } = await import("../lib/settings");
  const { storeRecording } = await import("../lib/recordings/store");
  const { transcribeLecture, untranscribed, queueTranscribe } = await import("../lib/recordings/service");
  const { materialsDir } = await import("../lib/paths");
  const { scanFolder } = await import("../lib/scan");
  const provider = new FakeProvider(0);
  const realFetch = globalThis.fetch;
  try {
    await applyMigrations();
    await setSetting("mode", "auto");
    const course = await prisma.course.create({ data: { code: "REC1", title: "Recordings fixture" } });
    const lecture = async (title: string) => {
      const l = await prisma.lecture.create({ data: { courseId: course.id, title, deliveredOn: new Date() } });
      await prisma.material.create({
        data: {
          lectureId: l.id,
          kind: "SLIDES",
          path: "x.pdf",
          originalName: "slides.pdf",
          checksum: `slides-${l.id}`,
          extractedText: "--- Slide 1 ---\nIgA nephropathy: IgA deposits in the mesangium of the glomerulus.",
        },
      });
      return l;
    };
    const source = path.join(dir, "Lecture 4.mp4");
    await writeFile(source, Buffer.alloc(64 * 1024, 7));

    // Kept by streaming, never read into memory; the same recording twice is kept once.
    const one = await lecture("IgA nephropathy");
    const stored = await storeRecording({ lectureId: one.id, name: "Lecture 4.mp4", from: source });
    assert.equal(stored.added, true);
    const again = await storeRecording({ lectureId: one.id, name: "copy.mp4", from: new Blob([await readFile(source)]).stream() });
    assert.deepEqual(again, { materialId: stored.materialId, added: false });
    assert.equal((await untranscribed(one.id)).length, 1);

    // Claude Code is the AI: Whisper transcribes, the AI fixes the technical words.
    const details: string[] = [];
    const done = await transcribeLecture(one.id, provider, (d) => d && details.push(d));
    assert.equal(done.transcribed, 1);
    assert.ok(done.fixes >= 1, "the AI corrected a misheard word");
    assert.ok(details.some((d) => d.startsWith("Downloading the speech model")), "progress is reported");
    const recording = await prisma.material.findUniqueOrThrow({ where: { id: stored.materialId } });
    assert.ok(recording.path.endsWith(".aac"), "a video is cut down to its sound");
    assert.equal(existsSync(path.join(materialsDir(), recording.path)), true);
    assert.equal(existsSync(path.join(materialsDir(), recording.path.replace(/\.aac$/, ".mp4"))), false, "the video itself isn't kept");
    assert.equal(recording.durationSec, 2400);
    const transcript = await prisma.material.findFirstOrThrow({ where: { lectureId: one.id, kind: "TRANSCRIPT" } });
    assert.equal(transcript.sourceId, recording.id);
    assert.match(transcript.madeBy ?? "", /^Whisper \(accurate\), checked by Fake/);
    assert.ok(transcript.extractedText!.startsWith("[00:00] Today, the glow merula."), transcript.extractedText!);
    assert.ok(transcript.extractedText!.includes("[00:50] IgA deposits sit in the mesangium."), "I G A → IgA");
    assert.ok(transcript.extractedText!.includes("[39:50] That's all."));
    assert.equal((await prisma.lecture.findUniqueOrThrow({ where: { id: one.id } })).durationHours, 0.5);
    assert.equal((await untranscribed(one.id)).length, 0);
    assert.equal((await transcribeLecture(one.id, provider)).transcribed, 0, "not transcribed twice");

    // Copy & paste mode has no AI: Whisper alone.
    const two = await lecture("Nephrotic syndrome");
    await storeRecording({ lectureId: two.id, name: "nephrotic.m4a", from: source });
    const plain = await transcribeLecture(two.id, null);
    assert.deepEqual(plain.via, ["Whisper (accurate)"]);
    assert.ok((await prisma.material.findFirstOrThrow({ where: { lectureId: two.id, kind: "TRANSCRIPT" } })).extractedText!.includes("I G A"));
    // A lecture with captions of its own isn't transcribed: captions beat any speech model.
    const three = await lecture("Captioned");
    await prisma.material.create({ data: { lectureId: three.id, kind: "TRANSCRIPT", path: "c.vtt", originalName: "c.vtt", checksum: "c", extractedText: "[00:00] Hi." } });
    await storeRecording({ lectureId: three.id, name: "c.mp3", from: source });
    assert.equal((await untranscribed(three.id)).length, 0);

    // Gemini is the AI: the sound goes straight to Gemini, part by part, uploaded first.
    await setSetting("cloudEngine", "api");
    await setSetting("apiService", "gemini");
    await setSetting("apiModel", "");
    await setApiKey("test-key");
    const calls: string[] = [];
    let failGenerate = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.replace(/^https:\/\/generativelanguage\.googleapis\.com/, "")}`);
      assert.equal((init?.headers as Record<string, string>)?.["x-goog-api-key"] ?? "test-key", "test-key");
      if (url.endsWith("/upload/v1beta/files")) return new Response("{}", { headers: { "x-goog-upload-url": "https://upload.example/session" } });
      if (url === "https://upload.example/session") {
        return Response.json({ file: { name: `files/f${calls.length}`, uri: `https://files/f${calls.length}`, state: "ACTIVE", mimeType: "audio/aac" } });
      }
      if (url.includes(":generateContent")) {
        if (failGenerate) return Response.json({ error: { message: "overloaded" } }, { status: 503 });
        const body = JSON.parse(String(init?.body));
        assert.equal(body.contents[0].parts[0].file_data.mime_type, "audio/aac");
        assert.match(body.contents[0].parts[1].text, /IgA/, "the slides' words are in the prompt");
        return Response.json({ candidates: [{ content: { parts: [{ text: "Sure, here it is:\n[00:00] Welcome back.\n[00:12] IgA nephropathy is next." }] } }] });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const four = await lecture("Heard by Gemini");
    await storeRecording({ lectureId: four.id, name: "four.mp4", from: source });
    const heard = await transcribeLecture(four.id, provider);
    assert.deepEqual(heard.via, ["Gemini · gemini-2.5-flash"]);
    assert.equal(heard.fixes, 0, "Gemini's own transcript isn't second-guessed");
    const geminiText = (await prisma.material.findFirstOrThrow({ where: { lectureId: four.id, kind: "TRANSCRIPT" } })).extractedText!;
    assert.equal(geminiText, "[00:00] Welcome back. [00:12] IgA nephropathy is next.\n\n[20:00] Welcome back. [20:12] IgA nephropathy is next.".replace(" [00:12]", "").replace(" [20:12]", ""));
    assert.equal(calls.filter((c) => c.includes(":generateContent")).length, 2, "one call per part");
    assert.equal(calls.filter((c) => c.startsWith("DELETE")).length, 2, "uploads are deleted after");

    // Gemini failing hands the recording to Whisper.
    failGenerate = true;
    const five = await lecture("Gemini down");
    await storeRecording({ lectureId: five.id, name: "five.mp4", from: source });
    const fellBack = await transcribeLecture(five.id, provider);
    assert.match(fellBack.via[0], /^Whisper/);
    assert.match(fellBack.notes[0], /Gemini couldn't transcribe it/);

    // With no helper, Gemini still takes audio it can hear as it is, but not a video.
    failGenerate = false;
    delete process.env.LOCKIN_WHISPER;
    const six = await lecture("Audio only");
    await storeRecording({ lectureId: six.id, name: "six.mp3", from: source });
    assert.deepEqual((await transcribeLecture(six.id, provider)).via, ["Gemini · gemini-2.5-flash"]);
    const seven = await lecture("Video, no helper");
    await storeRecording({ lectureId: seven.id, name: "seven.mov", from: source });
    await assert.rejects(transcribeLecture(seven.id, provider), /needs the transcription helper/);
    await setSetting("mode", "manual");
    await assert.rejects(transcribeLecture(seven.id, null), /needs Whisper/);
    process.env.LOCKIN_WHISPER = helper;

    // Queued once per lecture.
    const queued = await queueTranscribe(seven.id);
    assert.equal(await queueTranscribe(seven.id), queued);

    // A folder's recordings are found without being read.
    const folder = path.join(dir, "folder");
    await mkdir(folder);
    await writeFile(path.join(folder, "Lecture 4.mp4"), Buffer.alloc(1024));
    await writeFile(path.join(folder, "Lecture 4 slides.txt"), "--- Slide 1 ---\nIgA");
    const scan = await scanFolder(folder);
    const scanned = scan.files.find((f) => f.filename === "Lecture 4.mp4");
    assert.equal(scanned?.kindGuess, "RECORDING");
    assert.equal(scanned?.bytes, (await stat(path.join(folder, "Lecture 4.mp4"))).size);
    console.log("recordings check passed");
  } finally {
    globalThis.fetch = realFetch;
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
