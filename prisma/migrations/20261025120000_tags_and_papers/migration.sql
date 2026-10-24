-- AlterTable
ALTER TABLE "Flashcard" ADD COLUMN "suspended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Flashcard" ADD COLUMN "tags" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Question" ADD COLUMN "paperItemId" TEXT;

-- CreateIndex
CREATE INDEX "Question_paperItemId_idx" ON "Question"("paperItemId");
