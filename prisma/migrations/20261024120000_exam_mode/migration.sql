-- CreateTable
CREATE TABLE "Mcq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lectureId" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "answer" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "conceptId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Mcq_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Exam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "title" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "timeLimitMin" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ExamItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "examId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "mcqId" TEXT,
    "choice" INTEGER,
    "questionId" TEXT,
    "draftText" TEXT,
    "responseId" TEXT,
    CONSTRAINT "ExamItem_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExamItem_mcqId_fkey" FOREIGN KEY ("mcqId") REFERENCES "Mcq" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExamItem_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExamItem_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "Response" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- AlterTable: where each AK card came from; every existing card was generated.
ALTER TABLE "Flashcard" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'ai';

-- CreateIndex
CREATE INDEX "Mcq_lectureId_idx" ON "Mcq"("lectureId");

-- CreateIndex
CREATE INDEX "Exam_createdAt_idx" ON "Exam"("createdAt");

-- CreateIndex
CREATE INDEX "ExamItem_examId_idx" ON "ExamItem"("examId");
