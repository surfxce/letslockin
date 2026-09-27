-- CreateTable
CREATE TABLE "Module" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Module_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Lecture" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "moduleId" TEXT,
    "title" TEXT NOT NULL,
    "deliveredOn" DATETIME NOT NULL,
    "durationHours" REAL NOT NULL DEFAULT 1,
    "summaryMd" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Lecture_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Lecture_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Lecture" ("courseId", "createdAt", "deliveredOn", "durationHours", "id", "summaryMd", "title") SELECT "courseId", "createdAt", "deliveredOn", "durationHours", "id", "summaryMd", "title" FROM "Lecture";
DROP TABLE "Lecture";
ALTER TABLE "new_Lecture" RENAME TO "Lecture";
CREATE INDEX "Lecture_courseId_idx" ON "Lecture"("courseId");
CREATE INDEX "Lecture_moduleId_idx" ON "Lecture"("moduleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Module_courseId_idx" ON "Module"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "Module_courseId_title_key" ON "Module"("courseId", "title");
