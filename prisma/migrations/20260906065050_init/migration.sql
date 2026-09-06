-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "examDate" DATETIME,
    "weighting" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Lecture" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "deliveredOn" DATETIME NOT NULL,
    "durationHours" REAL NOT NULL DEFAULT 1,
    "summaryMd" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Lecture_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "lectureId" TEXT,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "extractedText" TEXT,
    "checksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Material_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Material_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Concept" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "lectureId" TEXT,
    "name" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "sourceRef" TEXT,
    "mergedIntoId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Concept_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Concept_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lectureId" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "rubric" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Question_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QuestionConcept" (
    "questionId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,

    PRIMARY KEY ("questionId", "conceptId"),
    CONSTRAINT "QuestionConcept_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuestionConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lectureId" TEXT NOT NULL,
    "sittingDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedBook" BOOLEAN NOT NULL DEFAULT true,
    "geometricMean" REAL,
    "completedAt" DATETIME,
    CONSTRAINT "Attempt_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Response" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "mark" REAL,
    "rubricVersion" TEXT,
    "rawMarkingJson" TEXT,
    "markedAt" DATETIME,
    CONSTRAINT "Response_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Response_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Gap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "responseId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Gap_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "Response" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Gap_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conceptId" TEXT NOT NULL,
    "dueOn" DATETIME NOT NULL,
    "intervalDays" REAL NOT NULL,
    "setByAttemptId" TEXT,
    "completedAt" DATETIME,
    CONSTRAINT "Review_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PastPaper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "label" TEXT,
    "materialId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PastPaper_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PastPaper_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "marksAllocated" REAL,
    "questionNumber" TEXT,
    CONSTRAINT "PaperItem_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "PastPaper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperItemConcept" (
    "paperItemId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,

    PRIMARY KEY ("paperItemId", "conceptId"),
    CONSTRAINT "PaperItemConcept_paperItemId_fkey" FOREIGN KEY ("paperItemId") REFERENCES "PaperItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperItemConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "result" TEXT,
    "promptVersion" TEXT,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Course_code_key" ON "Course"("code");

-- CreateIndex
CREATE INDEX "Lecture_courseId_idx" ON "Lecture"("courseId");

-- CreateIndex
CREATE INDEX "Material_lectureId_idx" ON "Material"("lectureId");

-- CreateIndex
CREATE INDEX "Material_courseId_idx" ON "Material"("courseId");

-- CreateIndex
CREATE INDEX "Concept_courseId_idx" ON "Concept"("courseId");

-- CreateIndex
CREATE INDEX "Concept_lectureId_idx" ON "Concept"("lectureId");

-- CreateIndex
CREATE INDEX "Question_lectureId_idx" ON "Question"("lectureId");

-- CreateIndex
CREATE INDEX "QuestionConcept_conceptId_idx" ON "QuestionConcept"("conceptId");

-- CreateIndex
CREATE INDEX "Attempt_lectureId_idx" ON "Attempt"("lectureId");

-- CreateIndex
CREATE INDEX "Response_attemptId_idx" ON "Response"("attemptId");

-- CreateIndex
CREATE INDEX "Response_questionId_idx" ON "Response"("questionId");

-- CreateIndex
CREATE INDEX "Gap_conceptId_idx" ON "Gap"("conceptId");

-- CreateIndex
CREATE INDEX "Gap_responseId_idx" ON "Gap"("responseId");

-- CreateIndex
CREATE INDEX "Review_conceptId_idx" ON "Review"("conceptId");

-- CreateIndex
CREATE INDEX "Review_dueOn_idx" ON "Review"("dueOn");

-- CreateIndex
CREATE INDEX "PastPaper_courseId_idx" ON "PastPaper"("courseId");

-- CreateIndex
CREATE INDEX "PaperItem_paperId_idx" ON "PaperItem"("paperId");

-- CreateIndex
CREATE INDEX "PaperItemConcept_conceptId_idx" ON "PaperItemConcept"("conceptId");

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");
