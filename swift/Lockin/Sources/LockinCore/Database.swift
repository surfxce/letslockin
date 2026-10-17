import CryptoKit
import Foundation
import GRDB

/// Opens `lockin.db` and ensures the Prisma schema is in place.
///
/// Uses the same `_prisma_migrations` bookkeeping as `lib/migrate.ts` so a database
/// created or migrated by the Swift app remains compatible with the Electron app and
/// `prisma migrate dev`.
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

    private static func migrate(writer: any DatabaseWriter, migrationsDir: URL?) throws {
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

            if let migrationsDir,
               let entries = try? FileManager.default.contentsOfDirectory(
                   at: migrationsDir,
                   includingPropertiesForKeys: [.isDirectoryKey],
                   options: [.skipsHiddenFiles]
               ),
               !entries.isEmpty {
                let done = try Set(
                    String.fetchAll(
                        db,
                        sql: #"SELECT migration_name FROM "_prisma_migrations" WHERE rolled_back_at IS NULL"#
                    )
                )
                let pending = entries
                    .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
                    .map(\.lastPathComponent)
                    .filter { !done.contains($0) }
                    .sorted()

                if !pending.isEmpty {
                    try db.execute(sql: "PRAGMA foreign_keys=OFF")
                    defer { try? db.execute(sql: "PRAGMA foreign_keys=ON") }

                    for name in pending {
                        let sqlURL = migrationsDir.appendingPathComponent(name).appendingPathComponent("migration.sql")
                        guard let sql = try? String(contentsOf: sqlURL, encoding: .utf8) else { continue }
                        let digest = SHA256.hash(data: Data(sql.utf8)).map { String(format: "%02x", $0) }.joined()
                        try db.inTransaction {
                            for statement in statementsIn(sql) {
                                try db.execute(sql: statement)
                            }
                            try db.execute(
                                sql: """
                                INSERT INTO "_prisma_migrations"
                                  (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
                                VALUES (?, ?, ?, current_timestamp, current_timestamp, 1)
                                """,
                                arguments: [UUID().uuidString.lowercased(), digest, name]
                            )
                            return .commit
                        }
                    }
                }
            } else {
                // Fallback when running without the prisma/migrations folder: create the current schema if missing.
                let hasCourse = try Bool.fetchOne(
                    db,
                    sql: #"SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Course')"#
                ) ?? false
                if !hasCourse {
                    for statement in statementsIn(fallbackSchemaSQL) {
                        try db.execute(sql: statement)
                    }
                }
            }
        }
    }

    private static let fallbackSchemaSQL = """
    CREATE TABLE IF NOT EXISTS "Course" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "code" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "examDate" DATETIME,
        "weighting" REAL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "Course_code_key" ON "Course"("code");

    CREATE TABLE IF NOT EXISTS "Module" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "courseId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "position" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Module_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Module_courseId_idx" ON "Module"("courseId");
    CREATE UNIQUE INDEX IF NOT EXISTS "Module_courseId_title_key" ON "Module"("courseId", "title");

    CREATE TABLE IF NOT EXISTS "Lecture" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "courseId" TEXT NOT NULL,
        "moduleId" TEXT,
        "title" TEXT NOT NULL,
        "deliveredOn" DATETIME NOT NULL,
        "durationHours" REAL NOT NULL DEFAULT 1,
        "summaryMd" TEXT,
        "autoTitle" BOOLEAN NOT NULL DEFAULT false,
        "skipped" TEXT,
        "slideNotes" TEXT,
        "summaryModel" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Lecture_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "Lecture_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Lecture_courseId_idx" ON "Lecture"("courseId");
    CREATE INDEX IF NOT EXISTS "Lecture_moduleId_idx" ON "Lecture"("moduleId");

    CREATE TABLE IF NOT EXISTS "GlossaryTerm" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "lectureId" TEXT NOT NULL,
        "term" TEXT NOT NULL,
        "explanation" String NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "GlossaryTerm_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "GlossaryTerm_lectureId_idx" ON "GlossaryTerm"("lectureId");

    CREATE TABLE IF NOT EXISTS "Material" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "courseId" TEXT,
        "lectureId" TEXT,
        "kind" TEXT NOT NULL,
        "path" TEXT NOT NULL,
        "originalName" TEXT NOT NULL,
        "extractedText" TEXT,
        "pageCount" INTEGER,
        "checksum" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Material_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "Material_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Material_lectureId_idx" ON "Material"("lectureId");
    CREATE INDEX IF NOT EXISTS "Material_courseId_idx" ON "Material"("courseId");

    CREATE TABLE IF NOT EXISTS "Concept" (
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
    CREATE INDEX IF NOT EXISTS "Concept_courseId_idx" ON "Concept"("courseId");
    CREATE INDEX IF NOT EXISTS "Concept_lectureId_idx" ON "Concept"("lectureId");

    CREATE TABLE IF NOT EXISTS "Question" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "lectureId" TEXT NOT NULL,
        "stem" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "rubric" TEXT NOT NULL,
        "promptVersion" TEXT NOT NULL,
        "model" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Question_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Question_lectureId_idx" ON "Question"("lectureId");

    CREATE TABLE IF NOT EXISTS "QuestionConcept" (
        "questionId" TEXT NOT NULL,
        "conceptId" TEXT NOT NULL,
        PRIMARY KEY ("questionId", "conceptId"),
        CONSTRAINT "QuestionConcept_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "QuestionConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "QuestionConcept_conceptId_idx" ON "QuestionConcept"("conceptId");

    CREATE TABLE IF NOT EXISTS "Attempt" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "lectureId" TEXT NOT NULL,
        "sittingDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "closedBook" BOOLEAN NOT NULL DEFAULT true,
        "geometricMean" REAL,
        "completedAt" DATETIME,
        "source" TEXT NOT NULL DEFAULT 'APP',
        CONSTRAINT "Attempt_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Attempt_lectureId_idx" ON "Attempt"("lectureId");

    CREATE TABLE IF NOT EXISTS "Response" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "attemptId" TEXT NOT NULL,
        "questionId" TEXT NOT NULL,
        "answerText" TEXT NOT NULL,
        "draftText" TEXT,
        "mark" REAL,
        "rubricVersion" TEXT,
        "rawMarkingJson" TEXT,
        "markedAt" DATETIME,
        CONSTRAINT "Response_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "Response_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Response_attemptId_idx" ON "Response"("attemptId");
    CREATE INDEX IF NOT EXISTS "Response_questionId_idx" ON "Response"("questionId");

    CREATE TABLE IF NOT EXISTS "Gap" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "responseId" TEXT NOT NULL,
        "conceptId" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Gap_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "Response" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "Gap_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Gap_conceptId_idx" ON "Gap"("conceptId");
    CREATE INDEX IF NOT EXISTS "Gap_responseId_idx" ON "Gap"("responseId");

    CREATE TABLE IF NOT EXISTS "Review" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "conceptId" TEXT NOT NULL,
        "dueOn" DATETIME NOT NULL,
        "intervalDays" REAL NOT NULL,
        "setByAttemptId" TEXT,
        "completedAt" DATETIME,
        CONSTRAINT "Review_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Review_conceptId_idx" ON "Review"("conceptId");
    CREATE INDEX IF NOT EXISTS "Review_dueOn_idx" ON "Review"("dueOn");

    CREATE TABLE IF NOT EXISTS "PastPaper" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "courseId" TEXT NOT NULL,
        "year" INTEGER NOT NULL,
        "label" TEXT,
        "materialId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PastPaper_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "PastPaper_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "PastPaper_courseId_idx" ON "PastPaper"("courseId");

    CREATE TABLE IF NOT EXISTS "PaperItem" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "paperId" TEXT NOT NULL,
        "stem" TEXT NOT NULL,
        "marksAllocated" REAL,
        "questionNumber" TEXT,
        CONSTRAINT "PaperItem_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "PastPaper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "PaperItem_paperId_idx" ON "PaperItem"("paperId");

    CREATE TABLE IF NOT EXISTS "PaperItemConcept" (
        "paperItemId" TEXT NOT NULL,
        "conceptId" TEXT NOT NULL,
        PRIMARY KEY ("paperItemId", "conceptId"),
        CONSTRAINT "PaperItemConcept_paperItemId_fkey" FOREIGN KEY ("paperItemId") REFERENCES "PaperItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "PaperItemConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "PaperItemConcept_conceptId_idx" ON "PaperItemConcept"("conceptId");

    CREATE TABLE IF NOT EXISTS "Job" (
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
        "model" TEXT,
        "durationMs" INTEGER,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "startedAt" DATETIME,
        "finishedAt" DATETIME,
        CONSTRAINT "Job_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "Job_status_priority_createdAt_idx" ON "Job"("status", "priority", "createdAt");
    CREATE INDEX IF NOT EXISTS "Job_lectureId_idx" ON "Job"("lectureId");

    CREATE TABLE IF NOT EXISTS "Setting" (
        "key" TEXT NOT NULL PRIMARY KEY,
        "value" TEXT NOT NULL,
        "updatedAt" DATETIME NOT NULL
    );
    """
}
