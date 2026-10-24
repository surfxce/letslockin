-- AlterTable
ALTER TABLE "Viva" ADD COLUMN "caseId" TEXT;

-- CreateTable
CREATE TABLE "ClinicalCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "presentation" TEXT NOT NULL,
    "stages" TEXT NOT NULL,
    "lectureIds" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClinicalCase_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lectureId" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "rubric" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paperItemId" TEXT,
    "linkedLectureIds" TEXT,
    "caseId" TEXT,
    CONSTRAINT "Question_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Question_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClinicalCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Question" ("createdAt", "id", "lectureId", "linkedLectureIds", "model", "paperItemId", "promptVersion", "rubric", "stem", "type") SELECT "createdAt", "id", "lectureId", "linkedLectureIds", "model", "paperItemId", "promptVersion", "rubric", "stem", "type" FROM "Question";
DROP TABLE "Question";
ALTER TABLE "new_Question" RENAME TO "Question";
CREATE INDEX "Question_lectureId_idx" ON "Question"("lectureId");
CREATE INDEX "Question_paperItemId_idx" ON "Question"("paperItemId");
CREATE INDEX "Question_caseId_idx" ON "Question"("caseId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ClinicalCase_courseId_idx" ON "ClinicalCase"("courseId");

