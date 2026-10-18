# Lockin in Swift — the plan

Why: the Electron app is ~357 MB (Chromium, Node, node_modules) and runs three processes
(Electron, the Next server, the worker) beside the model. A SwiftUI app is ~20–40 MB,
one process, and leaves that memory to the model. The model's own speed comes from the
engine, not the UI — so the first chunk is the engine (MLX), and it pays off before
the rest exists.

Decisions:

- **Apple Silicon, macOS 14+ (Sonoma).** MLX needs Apple Silicon. The Electron app
  stays for Windows (and Intel Macs) on llama.cpp, in maintenance mode.
- **Same database.** The Swift app opens the existing `lockin.db` (GRDB over SQLite,
  the Prisma schema as is) and the same `materials/` folder, so nothing is migrated
  by hand and either app can be used during the move.
- **Same prompts.** `prompts/*.md` stay the source; both apps read them.
- **Built and tested on GitHub's Macs.** Development sessions run on Linux, so
  `swift build` and `swift test` run in CI (`.github/workflows/swift.yml`);
  anything on screen is checked by hand on a real Mac.
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

### 2. The app's skeleton and data — built
`swift/Lockin`: SwiftPM package with app target `Lockin` and library target `LockinCore`
(plus `project.yml` XcodeGen spec for `Lockin.app`). GRDB 7 models for all Prisma tables
(Course, Module, Lecture, Material, Concept, Question, QuestionConcept, Attempt, Response,
Gap, Review, PastPaper, PaperItem, PaperItemConcept, Job, GlossaryTerm, Setting) with open
string-backed kind/status structs and `PrismaDate` decoding for both Prisma ISO-8601 and
SQLite timestamps. Opens the Electron app's `lockin.db` with a 5s busy timeout, applies and
records `prisma/migrations/` in `_prisma_migrations`, and surfaces database errors with a
Retry screen rather than silently opening an empty in-memory DB. SwiftUI `NavigationSplitView`
sidebar with live GRDB `ValueObservation`.

### 3. The engines, with their tests — built
Ported `lib/engines/` (geometric mean, mastery, allocation, question picker, review
schedule), `lib/parse/aims.ts`, `lib/group.ts` (folder → lectures), `lib/paste.ts`, and
`lib/markdown.ts` (slide markers and crops) into `LockinCore`. Ported the Vitest suites to
XCTest (`swift test` runs in CI via `.github/workflows/swift.yml`).

### 4. The lecture library — built
Ported `lib/format.ts`, `lib/status.ts`, `lib/views.ts` (`lectureRows`, `dueLectures`,
`questionNumbers`), `LectureTable.tsx` sorting (nulls last) and grouping (by module, status,
or course with module score averages), and `describeModels` into `LockinCore`. Built the
SwiftUI `LectureLibraryView` (due strip, sort presets, module/status/course grouping, search,
table columns) and `LectureDetailView` (breadcrumbs, `L<ordinal>` + `ModelInfoPopoverView` ⓘ,
inline-editable properties grid, Summary / LAQs / Scores / Details tabs).

### 5. Importing — built
Ported `lib/parse/index.ts` (`.vtt`/`.srt` captions with repeat deduplication and duration
measurement, `.pdf` via PDFKit, `.pptx` via in-memory ZIP + `Compression` inflate, `.md`/`.txt`),
`lib/scan.ts` (`scanFolder`), `lib/sortfiles.ts` (`excerptOf`, `describeForSort`,
`formatSortFilesVar`, `resolveFolderSortResponse`, `enqueueSortJob`), `ImportFlow.tsx` review
helpers (`existingFilesInCourse`, `homeLectureOf`, `buildImportReviewRows`,
`moveFileInReviewRows`), and `lib/materials.ts` (`ingestFile`, `queuePrepare`,
`importReviewedLectures`) into `LockinCore`. Built the SwiftUI `ImportFolderView` (folder
picker, local vs AI sorting, review list with untick, retitle, move/drop/restore files, and
adding files to existing lectures).

### 6. The job queue and the AI providers — built
An in-process `JobQueue` actor (no worker process required): stages, progress steps, cancel,
priority side lanes, and cloud → offline fallback. Providers: Claude Code, Codex, Antigravity CLIs,
Anthropic / OpenAI-compatible HTTP APIs via URLSession, and local MLX. Worker heartbeat yielding
between Electron worker and Swift app. SwiftUI `QueuePanelButton` with live activity popover.

### 7. Slides — built
`SlideRenderer` with PDFKit for page rasterisation (1280 px PNGs) and crop extraction; Vision
framework `VNRecognizeTextRequest` for picture-only OCR slides; `SlideText` and deck collation;
and `VisionPass` on MLX.

### 8. Reading a summary — built
The `WKWebView`-backed summary reader: Markdown rendering, slide pictures served via custom
`WKURLSchemeHandler` (`lockin-slide://`), slide crop modal/sheet with visual cropping rectangle,
reading place (`lockin.readAt.<id>`) persistence, glossary term highlights and popovers, selection
break-down tool, floating `? Ask` panel with history and questions, and left-out items banner.

### 9. Editing a summary — built
Formatted and Markdown summary editor in `WKWebView` with dot-point levels, line kinds, selection
tools, and keyboard shortcuts, saving via `WKScriptMessageHandler` and debounced database updates.
Ported `SummaryTools`, `SummaryEdit`, `renderMarkdown`, and Vitest test suites to Swift.

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
