-- Hand-written rather than generated. Prisma's SQLite output rebuilds Lecture and
-- Attempt with DROP TABLE, and the desktop app applies migrations inside a
-- transaction, where PRAGMA foreign_keys=OFF is ignored: dropping Lecture would
-- cascade and delete every material, concept, question and attempt. Columns are
-- added in place instead. Only Job is rebuilt, because nothing references it.

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- AlterTable
ALTER TABLE "Lecture" ADD COLUMN "autoTitle" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Lecture" ADD COLUMN "skipped" TEXT;

-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'APP';

-- RedefineTables
CREATE TABLE "new_Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "lectureId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT,
    "steps" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "result" TEXT,
    "promptVersion" TEXT,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "Job_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Old jobs keep their history, and gain the lecture they were for when it still exists.
INSERT INTO "new_Job" ("attempts", "createdAt", "durationMs", "error", "finishedAt", "id", "kind", "payload", "promptVersion", "result", "startedAt", "status", "lectureId")
SELECT "attempts", "createdAt", "durationMs", "error", "finishedAt", "id", "kind", "payload", "promptVersion", "result", "startedAt", "status",
       CASE WHEN json_valid("payload") AND json_extract("payload", '$.lectureId') IN (SELECT "id" FROM "Lecture")
            THEN json_extract("payload", '$.lectureId') END
FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_status_priority_createdAt_idx" ON "Job"("status", "priority", "createdAt");
CREATE INDEX "Job_lectureId_idx" ON "Job"("lectureId");

-- Unfinished work from the old pipeline. Summarise and extract-concepts are now one
-- PREPARE step per lecture; folder identification happens locally, so a queued
-- IDENTIFY has nothing left to do.
UPDATE "Job" SET "kind" = 'PREPARE', "status" = 'PENDING'
WHERE "kind" IN ('SUMMARISE', 'EXTRACT_CONCEPTS') AND "status" IN ('PENDING', 'RUNNING') AND "lectureId" IS NOT NULL;
DELETE FROM "Job"
WHERE "kind" IN ('SUMMARISE', 'EXTRACT_CONCEPTS', 'IDENTIFY') AND "status" IN ('PENDING', 'RUNNING');
-- A lecture that had both old steps queued now has two PREPAREs. Keep one.
DELETE FROM "Job"
WHERE "kind" = 'PREPARE' AND "status" = 'PENDING' AND "id" NOT IN (
  SELECT MIN("id") FROM "Job" WHERE "kind" = 'PREPARE' AND "status" = 'PENDING' GROUP BY "lectureId"
);
UPDATE "Job" SET "priority" = 10 WHERE "kind" = 'MARK';
