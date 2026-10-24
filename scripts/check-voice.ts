/** Isolated check of the Qwen voice's server: models downloaded, lines said through a stand-in speech helper (with the 1.7B's speaking style), and a helper that can't load saying why. Never touches the user's data. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const FAKE_HELPER = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), os = require("os");
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const opt = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const models = opt("--models"), variant = opt("--variant") || "0.6b";
const marker = path.join(models, variant === "0.6b" ? "ready.json" : "ready-" + variant + ".json");
if (process.argv[2] === "voice-download") {
  say({ stage: "download", progress: 0.5 });
  fs.mkdirSync(models, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ folder: models }));
  say({ folder: models });
  process.exit(0);
}
if (process.argv[2] !== "speak") { say({ error: "unknown" }); process.exit(1); }
if (process.env.FAKE_VOICE_FAIL === "json") { say({ error: "The natural voice couldn't load: no tokenizer.json" }); process.exit(1); }
if (process.env.FAKE_VOICE_FAIL === "crash") { process.stderr.write("dyld: Library not loaded: TTSKit\\n"); process.exit(6); }
say({ ready: true });
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line);
  const file = path.join(os.tmpdir(), "lockin-voice-check-" + r.id + ".wav");
  fs.writeFileSync(file, variant + " " + r.voice + (r.instruction ? " [" + r.instruction + "]" : "") + ": " + r.text);
  say({ id: r.id, path: file, duration: 1 });
});
`;

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-voice-check-"));
  process.env.LOCKIN_DATA_DIR = dir;
  const helper = path.join(dir, "lockin-whisper");
  await writeFile(helper, FAKE_HELPER);
  await chmod(helper, 0o755);
  process.env.LOCKIN_WHISPER = helper;
  const voice = await import("../lib/voice/natural");
  try {
    await assert.rejects(voice.speakNatural("Hello.", { voice: "aiden", model: "1.7b" }), /1\.7B hasn't been downloaded/);

    // Downloaded: the 1.7B, then the 0.6B, each marked apart.
    voice.startNaturalDownload("1.7b");
    for (let i = 0; i < 50 && !voice.naturalStatus().ready["1.7b"]; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(voice.naturalStatus().ready, { "1.7b": true, "0.6b": false });
    voice.startNaturalDownload("0.6b");
    for (let i = 0; i < 50 && !voice.naturalStatus().ready["0.6b"]; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(voice.naturalStatus().downloading["0.6b"]?.progress, 1);

    // Said by the one helper kept running; only the 1.7B is given the speaking style.
    const style = "Calm and kind.";
    assert.equal((await voice.speakNatural("Explain IgA nephropathy.", { voice: "serena", model: "1.7b", style })).toString(), "1.7b serena [Calm and kind.]: Explain IgA nephropathy.");
    assert.equal((await voice.speakNatural("Next question.", { voice: "ryan", model: "1.7b", style })).toString(), "1.7b ryan [Calm and kind.]: Next question.");
    // Switching model starts the helper afresh, on the other model.
    assert.equal((await voice.speakNatural("Quickly.", { voice: "aiden", model: "0.6b", style })).toString(), "0.6b aiden: Quickly.");

    // A helper that can't load says why — its own words, or what it printed as it died.
    voice.stopNaturalVoice();
    process.env.FAKE_VOICE_FAIL = "json";
    await assert.rejects(voice.speakNatural("Hello.", { voice: "aiden", model: "1.7b" }), /couldn't load: no tokenizer\.json/);
    process.env.FAKE_VOICE_FAIL = "crash";
    await assert.rejects(voice.speakNatural("Hello.", { voice: "aiden", model: "1.7b" }), /Library not loaded: TTSKit/);
    // And the next try starts it afresh.
    delete process.env.FAKE_VOICE_FAIL;
    assert.equal((await voice.speakNatural("Back again.", { voice: "aiden", model: "1.7b" })).toString(), "1.7b aiden: Back again.");
    voice.stopNaturalVoice();
    console.log("voice check passed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
