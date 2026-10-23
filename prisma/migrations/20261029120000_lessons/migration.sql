-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conceptId" TEXT NOT NULL,
    "lectureId" TEXT,
    "explanation" TEXT NOT NULL,
    "checks" TEXT NOT NULL,
    "gapCount" INTEGER NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" DATETIME,
    CONSTRAINT "Lesson_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Lesson_conceptId_idx" ON "Lesson"("conceptId");
