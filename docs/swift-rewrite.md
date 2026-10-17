# Lockin in Swift — the plan

Why: the Electron app is ~357 MB (Chromium, Node, node_modules) and runs three processes
(Electron, the Next server, the worker) beside the model. A SwiftUI app is ~20–40 MB,
one process, and leaves that memory to the model. The model's own speed comes from the
engine, not the UI — so the first chunk is the engine (MLX), and it pays off before
the rest exists.

Decisions:

- **Apple Silicon, macOS 26+.** MLX and Apple Intelligence need it. The Electron app
  stays for Windows (and Intel Macs) on llama.cpp, in maintenance mode.
- **Same database.** The Swift app opens the existing `lockin.db` (GRDB over SQLite,
  the Prisma schema as is) and the same `materials/` folder, so nothing is migrated
  by hand and either app can be used during the move.
- **Same prompts.** `prompts/*.md` stay the source; both apps read them.
- **Built and tested on GitHub's Macs.** Development sessions run on Linux, so
  `swift build` and `swift test` run in CI (`.github/workflows/mac-app.yml` grows a
  Swift job); anything on screen is checked by hand on a real Mac.
- **The summary reader and editor stay web.** A `WKWebView` (the system's WebKit,
  no size cost) shows summaries and runs the editor, reusing the existing Markdown
  rendering, glossary underlines, crop button and TipTap editor. Rewriting a rich
  text editor natively is the one part that costs far more than it saves.

## Chunks — one session each, roughly

### 1. `lockin-engine`: MLX, used by today's app — built
`swift/LockinEngine`: a Swift program holding one model, answering the worker a line of
JSON at a time over stdin/stdout (`lib/llm/mlx.ts`).
- mlx-swift-lm's MLXVLM / MLXLLM: Gemma 4 text and vision from one loaded copy.
- MLXGuidedGeneration holds replies to the same JSON schemas as llama.cpp's grammar.
- MLX copies from mlx-community download as folders that resume (`downloadMlxModel`);
  on Apple Silicon with the engine, new downloads are MLX, and Settings offers
  "Switch to MLX" for llama.cpp copies.
- Built by xcodebuild in CI and shipped in the .dmg's Resources/engine.
- Still to do: time a lecture on MLX against llama.cpp on a real Mac.
- Apple Intelligence (Foundation Models) for the short jobs: later, on request.

### 2. The app's skeleton and data — built
`swift/Lockin`: SwiftPM package with app target `Lockin` and library target `LockinCore`.
GRDB models for all Prisma tables (Course, Module, Lecture, Material, Concept, Question,
QuestionConcept, Attempt, Response, Gap, Review, PastPaper, PaperItem, PaperItemConcept,
Job, GlossaryTerm, Setting) with `PrismaDate` decoding for both Prisma ISO-8601 and SQLite
timestamps. Opens the Electron app's `lockin.db` and applies `prisma/migrations/`. SwiftUI
window, `NavigationSplitView` sidebar with live GRDB `ValueObservation`, course detail
skeleton, and empty states.

### 3. The engines, with their tests — built
Ported `lib/engines/` (geometric mean, mastery, allocation, question picker, review
schedule), `lib/parse/aims.ts`, `lib/group.ts` (folder → lectures), `lib/paste.ts`, and
`lib/markdown.ts` (slide markers, crops, and basic Markdown-to-HTML) into `LockinCore`.
Ported all Vitest suites to XCTest (`swift test` runs 74 tests across 8 suites in CI via
`.github/workflows/mac-app.yml`).

### 4. The lecture library
The home database (sort, group by module with averages, search, due strip), the
course filter, the lecture page header (properties, model ⓘ), tabs.

### 5. Importing
Folder picker, local grouping, the review list (untick, move files, retitle), AI
sorting through the engine, adding to existing lectures.

### 6. The job queue and the AI providers
A queue actor in-process (no worker): stages and progress, cancel, the side lanes,
cloud → offline fallback. Providers: Claude Code, Codex and Antigravity CLIs (Process),
the API keys (URLSession; Anthropic over HTTP, OpenAI-compatible), MLX and Foundation
Models from chunk 1.

### 7. Slides
PDFKit draws pages and crops (replaces unpdf + canvas); the Vision framework reads
picture-only slides (replaces tesseract.js and its bundled data); slide notes; the
vision pass on MLX.

### 8. Reading a summary
The WKWebView reader: Markdown, slide pictures, crop, reading place, the glossary,
select → break down, the ? Ask button, the left-out list.

### 9. Editing a summary
The editor (formatted / Markdown, dot point levels) in the same WKWebView, saving
through a message handler.

### 10. Practising
Starting a sitting, closed-book answers with drafts that save, marking, scores,
the notes sheet, the review schedule.

### 11. Export and copy & paste mode
PDF export through WKWebView's `createPDF` (the same document the Electron app
prints), and copy & paste mode's prompts and paste boxes.

### 12. Settings, onboarding, reminders
Settings (engines, models and downloads, LAQs, cloud), the onboarding tour,
UserNotifications reminders and the dock badge.

### 13. Updates and release
Sparkle for updates (signed with its own key; no Apple developer account needed),
the .dmg from CI, a parity checklist against the Electron app, then switching the
download link over.

## Not ported
The browser version and the dev server, `node-llama-cpp` (MLX replaces it on the
Mac), Electron's PDF window, `npm run worker`.
