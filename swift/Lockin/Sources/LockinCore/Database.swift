import CryptoKit
import Foundation
import GRDB

/// Opens `lockin.db` and ensures the Prisma migrations are applied and recorded.
///
/// Uses the exact same `_prisma_migrations` bookkeeping and migration SQL as
/// `lib/migrate.ts` so a database opened or migrated by the Swift app is always
/// compatible with the Electron app and `prisma migrate`.
public final class LockinDatabase: Sendable {
    public let writer: any DatabaseWriter
    public let path: String

    public var reader: any DatabaseReader { writer }

    public init(path: String = LockinPaths.databaseFile.path, migrationsDir: URL? = LockinPaths.migrationsDirectory) throws {
        self.path = path
        let dir = URL(fileURLWithPath: path).deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        var config = Configuration()
        config.foreignKeysEnabled = true
        config.busyMode = .timeout(5)
        let pool = try DatabasePool(path: path, configuration: config)
        self.writer = pool
        try Self.migrate(writer: pool, migrationsDir: migrationsDir)
    }

    private init(inMemoryQueue: DatabaseQueue) throws {
        self.path = ":memory:"
        self.writer = inMemoryQueue
        try Self.migrate(writer: inMemoryQueue, migrationsDir: LockinPaths.migrationsDirectory)
    }

    public static func inMemory() throws -> LockinDatabase {
        var config = Configuration()
        config.foreignKeysEnabled = true
        config.busyMode = .timeout(5)
        let queue = try DatabaseQueue(configuration: config)
        return try LockinDatabase(inMemoryQueue: queue)
    }

    // MARK: - Migrations

    public static func statementsIn(_ sql: String) -> [String] {
        sql
            .components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("--") }
            .joined(separator: "\n")
            .components(separatedBy: ";")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// All Prisma migrations shipped with Lockin (`prisma/migrations/`), in chronological order.
    /// Embedded so that even when running without an external `migrations/` folder, every migration
    /// is applied and recorded in `_prisma_migrations` identically to `lib/migrate.ts`.
    public static let embeddedMigrations: [(name: String, sql: String)] = [
        ("20260906065050_init", migration20260906065050Init),
        ("20260906072946_modules", migration20260906072946Modules),
        ("20261012032717_lecture_by_lecture", migration20261012032717LectureByLecture),
        ("20261012120000_slides", migration20261012120000Slides),
        ("20261013120000_study_tools", migration20261013120000StudyTools),
    ]

    private static func resolveMigrations(from migrationsDir: URL?) -> [(name: String, sql: String)] {
        var byName: [String: String] = Dictionary(uniqueKeysWithValues: embeddedMigrations)
        if let migrationsDir,
           let entries = try? FileManager.default.contentsOfDirectory(
               at: migrationsDir,
               includingPropertiesForKeys: [.isDirectoryKey],
               options: [.skipsHiddenFiles]
           ) {
            for entry in entries where (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                let name = entry.lastPathComponent
                let sqlURL = entry.appendingPathComponent("migration.sql")
                if let sql = try? String(contentsOf: sqlURL, encoding: .utf8) {
                    byName[name] = sql
                }
            }
        }
        return byName.keys.sorted().compactMap { name in
            byName[name].map { (name: name, sql: $0) }
        }
    }

    private static func migrate(writer: any DatabaseWriter, migrationsDir: URL?) throws {
        let migrations = resolveMigrations(from: migrationsDir)
        try writer.writeWithoutTransaction { db in
            try db.execute(
                sql: """
                CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
                  "id" TEXT PRIMARY KEY NOT NULL,
                  "checksum" TEXT NOT NULL,
                  "finished_at" DATETIME,
                  "migration_name" TEXT NOT NULL,
                  "logs" TEXT,
                  "rolled_back_at" DATETIME,
                  "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
                  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
                )
                """
            )

            let done = try Set(
                String.fetchAll(
                    db,
                    sql: #"SELECT migration_name FROM "_prisma_migrations" WHERE rolled_back_at IS NULL"#
                )
            )
            let pending = migrations.filter { !done.contains($0.name) }
            guard !pending.isEmpty else { return }

            try db.execute(sql: "PRAGMA foreign_keys=OFF")
            defer { try? db.execute(sql: "PRAGMA foreign_keys=ON") }

            for item in pending {
                let digest = SHA256.hash(data: Data(item.sql.utf8)).map { String(format: "%02x", $0) }.joined()
                try db.inTransaction {
                    for statement in statementsIn(item.sql) {
                        try db.execute(sql: statement)
                    }
                    try db.execute(
                        sql: """
                        INSERT INTO "_prisma_migrations"
                          (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
                        VALUES (?, ?, ?, current_timestamp, current_timestamp, 1)
                        """,
                        arguments: [UUID().uuidString.lowercased(), digest, item.name]
                    )
                    return .commit
                }
            }
        }
    }

    // MARK: - Embedded Prisma Migration SQL

    private static let migration20260906065050Init = """
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
    CREATE INDEX "Lecture_courseId_idx" ON "Lecture"("courseId");
    CREATE INDEX "Material_lectureId_idx" ON "Material"("lectureId");
    CREATE INDEX "Material_courseId_idx" ON "Material"("courseId");
    CREATE INDEX "Concept_courseId_idx" ON "Concept"("courseId");
    CREATE INDEX "Concept_lectureId_idx" ON "Concept"("lectureId");
    CREATE INDEX "Question_lectureId_idx" ON "Question"("lectureId");
    CREATE INDEX "QuestionConcept_conceptId_idx" ON "QuestionConcept"("conceptId");
    CREATE INDEX "Attempt_lectureId_idx" ON "Attempt"("lectureId");
    CREATE INDEX "Response_attemptId_idx" ON "Response"("attemptId");
    CREATE INDEX "Response_questionId_idx" ON "Response"("questionId");
    CREATE INDEX "Gap_conceptId_idx" ON "Gap"("conceptId");
    CREATE INDEX "Gap_responseId_idx" ON "Gap"("responseId");
    CREATE INDEX "Review_conceptId_idx" ON "Review"("conceptId");
    CREATE INDEX "Review_dueOn_idx" ON "Review"("dueOn");
    CREATE INDEX "PastPaper_courseId_idx" ON "PastPaper"("courseId");
    CREATE INDEX "PaperItem_paperId_idx" ON "PaperItem"("paperId");
    CREATE INDEX "PaperItemConcept_conceptId_idx" ON "PaperItemConcept"("conceptId");
    CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");
    """

    private static let migration20260906072946Modules = """
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
    CREATE UNIQUE INDEX "Module_courseId_title_key" ON "Module"("courseId", "title");
    """

    private static let migration20261012032717LectureByLecture = """
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
    INSERT INTO "new_Job" ("attempts", "createdAt", "durationMs", "error", "finishedAt", "id", "kind", "payload", "promptVersion", "result", "startedAt", "status", "lectureId")
    SELECT "attempts", "createdAt", "durationMs", "error", "finishedAt", "id", "kind", "payload", "promptVersion", "result", "startedAt", "status",
           CASE WHEN json_valid("payload") AND json_extract("payload", '$.lectureId') IN (SELECT "id" FROM "Lecture")
                THEN json_extract("payload", '$.lectureId') END
    FROM "Job";
    DROP TABLE "Job";
    ALTER TABLE "new_Job" RENAME TO "Job";
    CREATE INDEX "Job_status_priority_createdAt_idx" ON "Job"("status", "priority", "createdAt");
    CREATE INDEX "Job_lectureId_idx" ON "Job"("lectureId");

    UPDATE "Job" SET "kind" = 'PREPARE', "status" = 'PENDING'
    WHERE "kind" IN ('SUMMARISE', 'EXTRACT_CONCEPTS') AND "status" IN ('PENDING', 'RUNNING') AND "lectureId" IS NOT NULL;
    DELETE FROM "Job"
    WHERE "kind" IN ('SUMMARISE', 'EXTRACT_CONCEPTS', 'IDENTIFY') AND "status" IN ('PENDING', 'RUNNING');
    DELETE FROM "Job"
    WHERE "kind" = 'PREPARE' AND "status" = 'PENDING' AND "id" NOT IN (
      SELECT MIN("id") FROM "Job" WHERE "kind" = 'PREPARE' AND "status" = 'PENDING' GROUP BY "lectureId"
    );
    UPDATE "Job" SET "priority" = 10 WHERE "kind" = 'MARK';
    """

    private static let migration20261012120000Slides = """
    ALTER TABLE "Material" ADD COLUMN "pageCount" INTEGER;
    ALTER TABLE "Lecture" ADD COLUMN "slideNotes" TEXT;
    """

    private static let migration20261013120000StudyTools = """
    CREATE TABLE "GlossaryTerm" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "lectureId" TEXT NOT NULL,
        "term" TEXT NOT NULL,
        "explanation" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "GlossaryTerm_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE INDEX "GlossaryTerm_lectureId_idx" ON "GlossaryTerm"("lectureId");

    ALTER TABLE "Lecture" ADD COLUMN "summaryModel" TEXT;
    ALTER TABLE "Question" ADD COLUMN "model" TEXT;
    ALTER TABLE "Job" ADD COLUMN "model" TEXT;
    ALTER TABLE "Response" ADD COLUMN "draftText" TEXT;
    """
}
