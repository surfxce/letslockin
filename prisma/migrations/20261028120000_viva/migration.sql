-- CreateTable
CREATE TABLE "Viva" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "title" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "turns" TEXT NOT NULL DEFAULT '[]',
    "current" INTEGER NOT NULL DEFAULT 0,
    "probes" INTEGER NOT NULL DEFAULT 0,
    "waitingOn" TEXT NOT NULL DEFAULT 'student',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "Viva_createdAt_idx" ON "Viva"("createdAt");
