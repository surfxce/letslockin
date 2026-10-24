-- Columns added in place (see 20261012032717_lecture_by_lecture for why tables are
-- never rebuilt here), and the glossary.

-- A lecture's glossary: phrases picked out of its summary, each with the short
-- explanation the student chose to keep.
CREATE TABLE "GlossaryTerm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lectureId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GlossaryTerm_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "GlossaryTerm_lectureId_idx" ON "GlossaryTerm"("lectureId");

-- Which model wrote a summary, a question, or did a job — shown on the lecture page.
ALTER TABLE "Lecture" ADD COLUMN "summaryModel" TEXT;
ALTER TABLE "Question" ADD COLUMN "model" TEXT;
ALTER TABLE "Job" ADD COLUMN "model" TEXT;

-- LAQ answers saved as they are typed, before the sitting is submitted.
ALTER TABLE "Response" ADD COLUMN "draftText" TEXT;
