# Lockin

Lectures in, exam practice out. Lockin turns each lecture's transcript and slides into a
summary and long-answer questions (LAQs), marks your closed-book answers against a fixed
marking guide, scores each sitting with the geometric mean, and tells you when each lecture
is due again.

## How it works

1. **Add lectures.** Point a course at the folder your files are in. Lockin pairs each
   transcript with its slides by lecture number, date, module folder or shared name — locally,
   in a second — and shows the list to check before importing. Past papers and course admin
   are set aside. Or add one lecture by dropping in files or pasting the transcript.
2. **Summary and LAQs**, one lecture at a time, in one of three modes (Settings):
   - **Claude Code** — the worker runs Claude Code on this computer. A lecture is read once
     to write its title, summary and concepts, then its LAQs are written; the next lecture
     starts only when that one is done. The top bar always says what it is on and for how
     long, and each lecture page shows its stages with start times.
   - **On this computer** — the same, on an open model downloaded to this computer, so it
     works with no internet and no account. Slower; see [Offline AI](#offline-ai).
   - **Copy & paste** — no AI runs locally. Each lecture has *Copy prompt* buttons for any AI
     chat (the prompt carries the transcript) and boxes that turn the pasted reply into a
     formatted summary, LAQ cards, or coloured scores, with a live preview before saving.
3. **Module aims are left out.** Slides that are a module's aims or learning objectives are
   dropped before any model sees them, and the prompts tell the model to ignore aims read
   aloud, housekeeping and acknowledgements. Each lecture page lists what was left out.
4. **Practise closed book.** *Start LAQs* asks two questions per lecture hour, weakest
   concepts first. Answers are marked against the guide frozen when the question was written.
   A sitting's score is the geometric mean of its marks, so one weak answer drags it down.
5. **Come back when due.** Score 7+ and the gap grows (1 → 3 → 7 → 14 → 30 days); 5–7 holds;
   under 5 it is back tomorrow; everything lands before the exam date. Due lectures show at
   the top of the home page and as a badge, and as notifications if they are turned on.

The home page is a database of every lecture: sort by date, weakest first or due soonest,
group by module (with each module's average) or status, and search.

## Running it

**Desktop app** (starts the server, the worker and migrations for you; reminders arrive even
with the window closed, and the dock shows how many lectures are due):

```bash
npm install
npm run desktop      # or `npm run dmg` to build a macOS installer
```

**In a browser**, two terminals:

```bash
cp .env.example .env
npm install && npm run db:migrate
npm run dev          # http://localhost:3000
npm run worker       # the AI queue and model downloads — not needed in copy & paste mode
```

Claude Code mode needs the Claude Code CLI: `npm i -g @anthropic-ai/claude-code`, then run
`claude` once to sign in. `LOCKIN_MODEL` picks the model. To try the app without model
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

- Models are saved in `models/` beside the source, or in the desktop app's data folder
  (`~/Library/Application Support/Lockin/models` on a Mac). Settings lists them, with
  *Use* and *Delete*.
- `LOCKIN_MODEL_MIRROR=https://host/path` downloads `<mirror>/<model id>.gguf` instead
  of from Hugging Face — for a campus copy, or a network that blocks it.

## Working on it

```bash
npm test             # vitest: grouping, aims filter, paste parsers, scheduling, scoring, model picks
npm run lint
npx tsc --noEmit
npm run smoke        # one real model call through the CLI
```

| Where | What |
| --- | --- |
| `app/` | Pages and server actions. `app/ui/` holds the shared client components. |
| `lib/group.ts` | Local folder → lectures grouping. |
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
