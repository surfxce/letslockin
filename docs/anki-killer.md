# AK in Electron

AK is a second library tab. Settings is now the cog at the right of the app header.
Each lecture can have one flashcard deck with Markdown questions and answers and
images from its own PDF slides. Generate a deck from AK, then reveal and rate each
card. Space reveals; 1–4 select the four ratings after revealing. Existing cards can
be reviewed offline in every AI mode.

Settings → AK → **Generate AK decks with lectures** is off by default. When enabled,
a successful PREPARE job separately queues FLASHCARDS. The existing summary, LAQs
and rubrics are unchanged. Existing lectures can be generated individually; the
setting does not retroactively queue the whole library. Decks use the selected AI
provider through a fresh call/conversation, a versioned prompt and validated JSON.
Cloud jobs run in their own lane; offline jobs wait for the main queue to be idle
to avoid competing model contexts. Cancelling or failing a deck leaves the lecture
intact. A completed deck is never overwritten by retries or lecture preparation.

The scheduler is SM-2-style, not Anki's FSRS implementation. New/learning cards:
missed → 1 minute, partial → 5 minutes, good → 1 day, easy → 4 days. Established
cards use increasing intervals with an ease factor; forgetting returns a card to
learning. Overdue means a previously seen card due before local midnight. Due now
includes overdue; new cards are counted separately. Reviews and card versions are
saved atomically, preventing double submissions or an old window from grading twice.

Images are grounded slide references, not AI-created pictures or remote URLs. The
model can put an image on either side; front images should not reveal the answer.
Non-PDF materials provide text, but do not currently provide card images. No .apkg
import/export, image occlusion or cloze card editor is included in this first version.

## Validation

- `npm test`: scheduler, output contract, plus the existing unit suite.
- `node --import tsx scripts/check-flashcards.ts`: creates and removes an isolated
  temporary database; tests migration, duplicate queue requests, retry safety,
  cancellation, atomic output validation, diagram references, duplicate cards,
  review persistence, stale/early review rejection, worker dispatch, opt-in/off
  preparation and cascade cleanup. Uses a fake provider; no real AI calls.
- `npx tsc --noEmit`, targeted ESLint and `npm run build`.
- Browser fixture check: deck counts, settings cog, toggle persistence, answer
  reveal, mouse/keyboard grading, completion and actual PDF slide rasterization.

The migration is additive and runs through the existing desktop startup migration
runner. Development databases must also apply pending migrations before opening AK.
Swift work is paused and has not been changed for this feature.
