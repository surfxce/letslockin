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
2. **Summary and LAQs**, one lecture at a time, in one of two modes (Settings):
   - **Automatic** — the worker runs Claude Code on this computer. A lecture is read once to
     write its title, summary and concepts, then its LAQs are written; the next lecture
     starts only when that one is done. The top bar always says what it is on and for how
     long, and each lecture page shows its stages with start times.
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
npm run worker       # the AI queue — not needed in copy & paste mode
```

Automatic mode needs the Claude Code CLI: `npm i -g @anthropic-ai/claude-code`, then run
`claude` once to sign in. `LOCKIN_MODEL` picks the model. To try the app without model
calls, run the worker with `LOCKIN_PROVIDER=fake`.

## Working on it

```bash
npm test             # vitest: grouping, aims filter, paste parsers, scheduling, scoring
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
| `lib/llm/` | The only place a model is called. `prompts/` holds the versioned prompts. |
| `electron/` | The desktop shell and its notifications. |

Migrations are applied by `prisma migrate dev` in development and by `lib/migrate.ts` inside
the packaged app. The latter runs each migration in a transaction, where SQLite ignores the
`PRAGMA foreign_keys=OFF` that Prisma puts around a table rebuild — so dropping a referenced
table would cascade-delete its children. `lib/migrate.ts` turns foreign keys off for the
whole run to prevent that; even so, prefer adding columns in place over rebuilding a table
(see `prisma/migrations/*_lecture_by_lecture`).
