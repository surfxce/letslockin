/** Isolated check of hearing a spoken answer live: sound in pieces through a stand-in speech helper, words back as they come, the final text, a new answer replacing one, and a helper that fails saying why. Never touches the user's data. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Each second of sound is one word; all but the last two are settled, as the real one does.
const FAKE_HELPER = `#!/usr/bin/env node
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const opt = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv[2] === "version") { say(process.env.FAKE_OLD ? { version: 4, voice: true } : { version: 5, voice: true, live: true }); process.exit(0); }
if (process.argv[2] !== "listen") { say({ error: "usage" }); process.exit(1); }
if (process.env.FAKE_LIVE_FAIL === "load") { say({ error: "Whisper couldn't load: no model" }); process.exit(1); }
say({ stage: "download", progress: 0.5 });
let answer = null, ready = false;
const words = () => Array.from({ length: Math.floor(answer.samples / 16000) }, (_, i) => opt("--model") + "-" + (i + 1));
setTimeout(() => { ready = true; say({ ready: true }); }, 200);
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.start) answer = { id: r.id, samples: 0, prompt: r.prompt };
  if (!answer || answer.id !== r.id) return;
  if (r.audio) {
    answer.samples += Buffer.from(r.audio, "base64").length / 2;
    if (process.env.FAKE_LIVE_FAIL === "pass") return say({ id: r.id, error: "Whisper tripped up" });
    const w = words();
    say({ id: r.id, confirmed: w.slice(0, -2).join(" "), tentative: w.slice(-2).join(" ") });
  }
  if (r.end) { say({ id: r.id, text: words().join(" ") + " [" + (answer.prompt || "") + "]", final: true }); answer = null; }
});
`;

const second = () => new Uint8Array(32_000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-live-check-"));
  process.env.LOCKIN_DATA_DIR = dir;
  const helper = path.join(dir, "lockin-whisper");
  await writeFile(helper, FAKE_HELPER);
  await chmod(helper, 0o755);
  process.env.LOCKIN_WHISPER = helper;
  const live = await import("../lib/viva/live");
  const { WHISPER_MODELS } = await import("../lib/modes");
  const fast = WHISPER_MODELS.fast.variant;
  try {
    assert.equal(await live.canHearLive(), true);

    // Sound sent before Whisper is ready isn't lost; words come back as they're heard.
    live.startLive("answer-1", { model: "fast", prompt: "mesangium, IgA" });
    const first = live.feedLive("answer-1", second());
    assert.match(first.preparing ?? "", /Loading Whisper|Downloading Whisper/);
    live.feedLive("answer-1", second());
    live.feedLive("answer-1", second());
    await wait(300);
    const heard = live.feedLive("answer-1", new Uint8Array(0));
    assert.deepEqual(heard, { confirmed: `${fast}-1`, tentative: `${fast}-2 ${fast}-3`, preparing: null });
    assert.equal(await live.finishLive("answer-1", second()), `${fast}-1 ${fast}-2 ${fast}-3 ${fast}-4 [mesangium, IgA]`);
    assert.throws(() => live.feedLive("answer-1", second()), /isn't being heard any more/);

    // A new answer replaces one left unfinished.
    live.startLive("answer-2", { model: "fast" });
    live.feedLive("answer-2", second());
    live.startLive("answer-3", { model: "fast" });
    assert.throws(() => live.feedLive("answer-2", second()), /isn't being heard any more/);
    assert.equal(await live.finishLive("answer-3", second()), `${fast}-1 []`);

    // Another Whisper model starts the helper afresh.
    const accurate = WHISPER_MODELS.accurate.variant;
    live.startLive("answer-4", { model: "accurate" });
    assert.equal(await live.finishLive("answer-4", second()), `${accurate}-1 []`);

    // A pass that fails is told to the page, which then has the whole recording heard.
    live.stopLive();
    process.env.FAKE_LIVE_FAIL = "pass";
    live.startLive("answer-5", { model: "fast" });
    live.feedLive("answer-5", second());
    await wait(300);
    assert.throws(() => live.feedLive("answer-5", second()), /Whisper tripped up/);

    // A helper that can't load says why, and the next answer starts it afresh.
    live.stopLive();
    process.env.FAKE_LIVE_FAIL = "load";
    live.startLive("answer-6", { model: "fast" });
    await wait(300);
    assert.throws(() => live.feedLive("answer-6", second()), /couldn't load: no model/);
    delete process.env.FAKE_LIVE_FAIL;
    live.startLive("answer-7", { model: "fast" });
    assert.equal(await live.finishLive("answer-7", second()), `${fast}-1 []`);
    live.stopLive();

    // A helper from before live hearing isn't asked to.
    process.env.FAKE_OLD = "1";
    await writeFile(helper, FAKE_HELPER + "\n");
    assert.equal(await live.canHearLive(), false);
    console.log("live hearing check passed");
  } finally {
    live.stopLive();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
