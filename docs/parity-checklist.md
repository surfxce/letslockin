# Swift app vs Electron — the parity checklist

Chunk 13's gate: before the download link moves to the Swift build, everything below is
ticked. The link moved on 2026-10-19 by owner decision (see the last section); the QA
list below is what still needs a real Mac and hands on it.

The app runs from the repo with `swift run Lockin` (uses the repo's own database), or as
a real app by generating the project and building:

```bash
brew install xcodegen
cd swift/Lockin && xcodegen generate && open Lockin.xcodeproj   # Run in Xcode
```

## What CI already checks on every push

- [x] `swift build` and `swift test` pass on a Mac (`.github/workflows/swift.yml`).
- [x] The `.dmg` builds with the engine inside and publishes to `swift-latest`
      (`.github/workflows/swift-dmg.yml`), with the Sparkle appcast when
      `SPARKLE_PRIVATE_KEY` is set.

## One-time setup still to do (key holder)

1. [ ] Put the signing key in CI: `gh secret set SPARKLE_PRIVATE_KEY < .sparkle-private-key`
      (the file is gitignored; it was exported once from the login keychain with
      `generate_keys -x`). Until then the workflow publishes the `.dmg` without an
      appcast, and Settings → Updates can't verify anything.
2. [ ] After the first signed build: check a real Mac updates from 0.1.0 build N to
      build N+1 through Settings → Updates without a reinstall.

## Parity — checked on a real Mac, by hand

### Import and the library

- [ ] Import a messy folder (mixed `.vtt`/`.pdf`/`.pptx`, wrong names, a course outline
      inside): the review rows, retitling, module assignment and set-aside files all
      match what the Electron app proposes.
- [ ] AI sorting of a folder works on the Swift queue, and its result reads the same in
      either app afterwards.
- [ ] The lecture library: due strip, sorts (nulls last), grouping by module/status/
      course, search, remembered view per course.
- [ ] The same `lockin.db` opened by both apps in turn — prepared lectures, sittings and
      scores are all visible to the other app, and only one runs the queue at a time
      (heartbeat taken over when the other closes).

### A lecture end to end

- [ ] Prepare a real lecture (transcript + slides): summary with section numbers, glossary
      underlines, slide pictures and crops, LAQs with marking guides, concepts with
      timestamps, left-out banner.
- [ ] Read the summary in the WKWebView reader: slide pictures serve, crops open, the
      `? Ask` panel answers, break-down tool works, reading place is remembered.
- [ ] Edit a summary in the editor; changes save and survive reopening.
- [ ] Drag crop handles on a real trackpad (roads: they are drag gestures, not clicks).
- [ ] Model ⓘ popover shows who did what and how long it took.

### Practising

- [ ] A full sitting on a real lecture: start, closed-book answering, saved drafts,
      submit, automatic marking, per-criterion feedback, geometric mean on the Scores tab.
- [ ] Pasted marking: the same sitting marked by pasting an AI's reply, from a lecture
      page, with the marks validated before they store.
- [ ] The review schedule moves like the Electron app's (1, 3, 7, 14, 30 days, pulled in
      before the exam date), and a pasted external score counts the same.
- [ ] Export PDF for a course with slide pictures; check pagination on A4 and Letter.

### Settings (chunk 12)

- [ ] Mode switching: Automatic (Claude Code), On this computer (MLX), Copy & paste —
      each prepares a lecture end to end.
- [ ] Cloud engines: Claude Code, Codex, Antigravity, and an API key (Anthropic +
      OpenAI-compatible) all prepare and mark; "Test it" tells the truth for each.
- [ ] Model downloads in the Swift app: pick one, watch progress, see it link up when it
      finishes; cancel keeps the partial and resumes; delete removes the files; the
      eye + writer pairs work, including downloading the missing half.
- [ ] LAQ counts and style apply to the next prepared lecture.
- [ ] Onboarding: the tour opens on first run, its model step appears for local mode,
      and "Repeat onboarding" from Settings replays it.

### Reminders (chunk 12)

- [ ] The dock badge shows the number of due lectures, whether or not notifications are
      on, and updates as sittings change the due set.
- [ ] A notification arrives while the window is closed (8am–10pm), one a day per
      lecture, and clicking it opens that lecture.
- [ ] The toggle's first turn-on asks permission; the "test" reminder arrives.

### Updates (chunk 13)

- [ ] Settings → Updates shows the version and build; "Check for updates" reports
      honestly when it is up to date.
- [ ] An update installs: it downloads, restarts the app, and lands on the newer build.
- [ ] With no `SPARKLE_PRIVATE_KEY` in CI, the workflow still publishes a `.dmg` and says
      plainly that updates can't verify.

### Both apps side by side

- [ ] Prepare a lecture in one app while the other is open; neither corrupts the
      database, and the queue panel in each shows who is running.
- [ ] A download started in the Swift app finishes while the Electron app starts up
      (the Electron worker must not requeue it out from under the Swift lane).

## When every box is ticked — switching the link over

**Switched on 2026-10-19 by owner decision**, ahead of the hand checks: the Swift build
is now what `mac-latest` publishes and what the README's download link serves
(`.github/workflows/swift-dmg.yml` is the only publisher of `mac-latest`; the Electron
mac build no longer publishes, and mac-app.yml keeps building it as a compile check).
The first `mac-latest` DMG from the Swift pipeline was broken — the app's contents sat
at the volume root instead of `Lockin.app`, from a BSD `cp` that renamed the bundle
when the stage folder didn't exist — which is the kind of thing the boxes below exist
to catch. The QA list stays open until it is worked through on a real Mac:

1. ~~Point the download link at the Swift release~~ done (same link, new publisher).
2. [x] The Electron workflow no longer publishes `mac-latest`.
3. [ ] Windows keeps the Electron app on llama.cpp, in maintenance mode, as the plan
       says — that port is still to do (see the conversation of 2026-10-19: wire
       `lib/command.ts` into the spawn sites, an nsis target, and a Windows QA pass).
