# Lockin

Lectures in, exam practice out. Lockin turns each lecture's transcript and slides into a
summary and long-answer questions (LAQs), marks your closed-book answers against a fixed
marking guide, scores each sitting with the geometric mean, and tells you when each lecture
is due again.

## How it works

1. **Add lectures.** Point a course at the folder your files are in, then choose how they
   become lectures:
   - **Sorted already** — files named by lecture are grouped from their names, locally, in a
     second: lecture numbers (L7, Lecture 07, Week 3 Lecture 2), codes (A4), dates, module
     folders or shared names. A file for several lectures (`A4-A5 slides`, `L4-5`,
     `Lectures 4 & 5`) goes into each of them.
   - **Sort with AI** — for a messy folder: Claude Haiku (or your offline model) reads the
     start of every file — a transcript's opening, each slide's first line — and works out
     which go together, which deck two lectures share, and what is not a lecture at all.

   Either way the list is shown to check and edit before anything is imported: untick a
   lecture, take a file out of one with its ×, retitle. Past papers and course admin are set
   aside. Files already in the course are recognised; new ones are added to the lecture they
   belong to rather than making a second copy of it. Or add one lecture by dropping in files
   or pasting the transcript.
2. **Summary and LAQs**, one lecture at a time, in one of three modes (Settings):
   - **Automatic** — the worker runs a cloud AI, chosen in Settings → Cloud AI:
     **Claude Code** (Sonnet by default; Opus or Haiku), **ChatGPT Codex** (the `codex` CLI,
     with a ChatGPT plan), **Google Antigravity** (the `agy` CLI, or the Gemini CLI it
     replaced), or **an API key** — Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, or any
     service that speaks OpenAI's chat format, such as Ollama. *Test it* sends one tiny
     question to check it is set up. A lecture is read once to write its title, summary and
     concepts, then its LAQs are written; the next lecture starts only when that one is done.
     The top bar always says what it is on and for how long, each lecture page shows its
     stages with start times, and the ⓘ by its number says which model wrote what. If the
     cloud AI fails (signed out, over a limit, offline) and an offline model is downloaded,
     that model does the job instead.
   - **On this computer** — the same, on an open model downloaded to this computer, so it
     works with no internet and no account. Slower; see [Offline AI](#offline-ai).
   - **Copy & paste** — no AI runs locally. Each lecture has *Copy prompt* buttons for any AI
     chat (the prompt carries the transcript) and boxes that turn the pasted reply into a
     formatted summary, LAQ cards, or coloured scores, with a live preview before saving.

   **Slides are read as pictures, and shown in summaries.** Every cloud AI sees the slides —
   Claude and Gemini open the PDF decks, Codex and image-capable API models are shown each
   page as a picture — so text inside images, diagrams, graphs and
   photos is read, not lost. Where a slide's figure helps, the summary shows it — the model
   writes `![what it shows](slide:12)` and Lockin puts the slide's picture there, drawn from
   the PDF the first time it is viewed. As it reads, Claude writes a note on each slide; the
   steps that write and mark LAQs, which only read text, use those notes. A deck shared by
   two lectures is copied into each, and each lecture covers only the part its transcript
   does. In copy & paste mode the prompt asks you to attach the PDF (there is a download
   button) and asks for the same slide pictures. Offline, see below. PowerPoint files give
   their text but not pictures — export them as PDF for that.
3. **Module aims are left out.** Slides that are a module's aims or learning objectives are
   dropped before any model sees them, and the prompts tell the model to ignore aims read
   aloud, housekeeping and acknowledgements. Each lecture page lists what was left out, folded
   to one line: hover a part to see what it said, click it to put it back in the summary.
4. **Practise closed book.** *Start LAQs* asks two questions per lecture hour (Settings → LAQs
   changes how many are written and asked, and their style: mixed, a short scenario, or
   straight to the point), weakest concepts first. Answers save as you type, and a sitting
   left unsubmitted is picked up again. They are marked against the guide frozen when the
   question was written. A sitting's score is the geometric mean of its marks, so one weak
   answer drags it down — and the result comes with a sheet of notes to copy down: what was
   wrong (✗), partly right (~) and missed (+).
5. **Come back when due.** Score 7+ and the gap grows (1 → 3 → 7 → 14 → 30 days); 5–7 holds;
   under 5 it is back tomorrow; everything lands before the exam date. Due lectures show at
   the top of the home page and as a badge, and as notifications if they are turned on.

**Reading a summary.** The round **?** in the corner asks a question answered from the
summary, and adds the answer under a heading of your choice. Select any text to have it
**broken down**, then *Add to glossary*: the words are underlined wherever they appear and
show the explanation on hover. **Edit** switches the summary to an editor — formatted, or as
Markdown — with headings and dot points at three levels (Tab and Shift+Tab move a point).
Lockin remembers how far down each summary you had read.

The home page is a database of every lecture: sort by date, weakest first or due soonest,
group by module (with each module's average) or status, and search.

## Running it

**Desktop app** (starts the server, the worker and migrations for you; reminders arrive even
with the window closed, and the dock shows how many lectures are due):

```bash
npm install
npm run desktop      # or `npm run dmg` to build a macOS installer
```

`npm run desktop` runs the app straight from this folder; nothing is installed. To have
Lockin in Applications, run `npm run dmg`, open the `.dmg` it puts in `release/` and drag Lockin
into Applications. It is not signed, so the first time, right-click it and choose
*Open*. The installed app keeps its own data in `~/Library/Application Support/Lockin`
(database, uploaded files, downloaded models), apart from this folder's — to bring your
lectures across, quit it and copy `prisma/lockin.db` there as `lockin.db`, along with
the `materials` folder. `npm run dmg` rebuilds the SQLite driver for Electron; run
`npm run rebuild:node` before using `npm run desktop` or `npm run dev` again.

**In a browser**, two terminals:

```bash
cp .env.example .env
npm install && npm run db:migrate
npm run dev          # http://localhost:3000
npm run worker       # the AI queue and model downloads — not needed in copy & paste mode
```

Claude Code needs its CLI: `npm i -g @anthropic-ai/claude-code`, then run `claude` once to
sign in; Codex needs `npm i -g @openai/codex` and `codex login`; Antigravity needs its CLI
from antigravity.google/cli and one run of `agy`. Settings picks the model; `LOCKIN_SORT_MODEL`
(default `haiku`) is the one that sorts folders, and `LOCKIN_EFFORT` (default `medium`) how
hard Claude Code thinks when preparing and marking. Claude is given one tool,
reading files, and only in the folder of the lecture's slides. To try the app without model
calls, run the worker with `LOCKIN_PROVIDER=fake`.

## Offline AI

Choosing *On this computer* (in the tour, or Settings → Offline AI) shows three models
picked for this computer from its memory and processor cores:

| Performance | Recommended | Quality |
| --- | --- | --- |
| One size smaller: faster | The largest that runs comfortably | One size larger: better, slower |

The ladder, smallest first: Qwen 3.5 0.8B, Gemma 4 E2B, E4B, 12B, 26B (a mixture of experts,
quick for its size) and 31B — all Q4_K_M GGUF files from Hugging Face, 0.6–19 GB. The
recommendation is the largest model whose memory need fits; on a PC without Apple Silicon
and with fewer than 8 cores it drops a size, because everything then runs on the processor
(`lib/llm/catalog.ts`, tested in `catalog.test.ts`).

Downloading runs in the worker, beside the queue, and survives restarts (it resumes the
partial file). When it finishes the model is linked: it becomes the one Lockin uses and the
mode switches to *On this computer* — nothing else to set. Lectures queued before then
wait rather than fail.

Models run through [node-llama-cpp](https://node-llama-cpp.withcat.ai), on the GPU where
there is one (Metal on Apple Silicon, CUDA or Vulkan on a PC) and the processor otherwise.
Output is constrained by a JSON-schema grammar, so a small model cannot return malformed
JSON, out-of-range marks or concept ids that do not exist. A transcript too long for the
model's context is read in parts and condensed first; the lecture page says which part it
is on.

**Gemma 4 sees the slides.** Gemma 4 takes images, but node-llama-cpp, which runs it, has
no way to pass one in. So downloading a Gemma model also fetches its vision part (the
"mmproj" file, from Hugging Face) and llama.cpp's own server (from its GitHub releases, or
the `llama-server` already on PATH, e.g. `brew install llama.cpp`). Before the summary is
written, that server is shown each slide and writes down every word on it and what each
figure shows; those notes go into the text the summary is written from, and are kept for
writing and marking LAQs. A model downloaded before this has a *Let it see slides* button in
Settings.

If that isn't there or fails, slides that are pictures have their words read by text
recognition instead (tesseract.js, with its English data bundled), kept in the deck's text
where Details & files shows it for correcting.

- Models are saved in `models/` beside the source, or in the desktop app's data folder
  (`~/Library/Application Support/Lockin/models` on a Mac). Settings lists them, with
  *Use* and *Delete*.
- `LOCKIN_MODEL_MIRROR=https://host/path` downloads `<mirror>/<model id>.gguf` instead
  of from Hugging Face — for a campus copy, or a network that blocks it.

## Working on it

```bash
npm test             # vitest: grouping, aims filter, paste parsers, scheduling, scoring, model picks, slides
npm run lint
npx tsc --noEmit
npm run smoke        # one real model call through the CLI
```

| Where | What |
| --- | --- |
| `app/` | Pages and server actions. `app/ui/` holds the shared client components. |
| `lib/group.ts` | Local folder → lectures grouping, and turning an AI's grouping (`lib/sortfiles.ts` builds what it reads) into the same list. |
| `lib/slides.ts`, `lib/sources.ts` | A lecture's decks, slide numbering across them, slide pictures drawn on demand; the text every prompt is built from. |
| `lib/ocr.ts`, `lib/slidetext.ts` | Reading the words on picture-only slides, for models that can't see. |
| `lib/runtime-import.ts` | Loading packages that must not be bundled — native binaries, and ESM that finds its own files. |
| `lib/parse/aims.ts` | The module-aims filter. |
| `lib/paste.ts`, `lib/offline.ts` | Copy-and-paste mode: what is pasted back, and the prompts that ask for it. They change together; `lib/offline.test.ts` holds them to it. |
| `lib/pipeline.ts`, `worker/` | The steps the worker runs, and the queue that runs them one at a time. |
| `lib/engines/` | Geometric mean, concept mastery, question allocation, the review schedule. |
| `lib/llm/` | The only place a model is called: `cli.ts` (Claude Code), `local.ts` (a downloaded model), `fake.ts`. `prompts/` holds the versioned prompts both use. |
| `lib/llm/catalog.ts`, `lib/models.ts` | The offline models on offer and the pick for this computer; which are downloaded, and downloads in progress. |
| `electron/` | The desktop shell and its notifications. |

Migrations are applied by `prisma migrate dev` in development and by `lib/migrate.ts` inside
the packaged app. The latter runs each migration in a transaction, where SQLite ignores the
`PRAGMA foreign_keys=OFF` that Prisma puts around a table rebuild — so dropping a referenced
table would cascade-delete its children. `lib/migrate.ts` turns foreign keys off for the
whole run to prevent that; even so, prefer adding columns in place over rebuilding a table
(see `prisma/migrations/*_lecture_by_lecture`).
