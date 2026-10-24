import Foundation

public struct GroupInput: Equatable, Sendable {
    public var relativePath: String
    public var kind: String
    public var modifiedOn: Date
    public var measuredHours: Double?

    public init(relativePath: String, kind: String, modifiedOn: Date, measuredHours: Double? = nil) {
        self.relativePath = relativePath
        self.kind = kind
        self.modifiedOn = modifiedOn
        self.measuredHours = measuredHours
    }
}

public struct ProposedLecture: Equatable, Sendable {
    public var title: String
    public var number: Int?
    public var label: String?
    public var moduleTitle: String?
    /// YYYY-MM-DD
    public var deliveredOn: String
    public var durationHours: Double
    public var fileIndexes: [Int]
    public var setAside: String?

    public init(
        title: String,
        number: Int?,
        label: String?,
        moduleTitle: String?,
        deliveredOn: String,
        durationHours: Double,
        fileIndexes: [Int],
        setAside: String?
    ) {
        self.title = title
        self.number = number
        self.label = label
        self.moduleTitle = moduleTitle
        self.deliveredOn = deliveredOn
        self.durationHours = durationHours
        self.fileIndexes = fileIndexes
        self.setAside = setAside
    }
}

public struct SortedFolder: Codable, Equatable, Sendable {
    public struct LectureItem: Codable, Equatable, Sendable {
        public var title: String
        public var module: String?
        public var files: [String]

        public init(title: String, module: String?, files: [String]) {
            self.title = title
            self.module = module
            self.files = files
        }
    }

    public struct SetAsideItem: Codable, Equatable, Sendable {
        public var file: String
        public var reason: String

        public init(file: String, reason: String) {
            self.file = file
            self.reason = reason
        }
    }

    public var lectures: [LectureItem]
    public var setAside: [SetAsideItem]

    public init(lectures: [LectureItem], setAside: [SetAsideItem]) {
        self.lectures = lectures
        self.setAside = setAside
    }
}

private let extRe = Regex.compile(#"\.[a-z0-9]+$"#, options: [.caseInsensitive])
private let weekAndLectureRe = Regex.compile(
    #"(?:^|[^a-z])w(?:ee)?k?[\s_\-.]*0*(\d{1,2})[\s_\-.]*(?:l|lec|lect|lecture)[\s_\-.]*0*(\d{1,2})(?!\d)"#,
    options: [.caseInsensitive]
)
private let lectureRe = Regex.compile(
    #"(?:^|[^a-z])(?:lecture|lect|lec|l)[\s_\-.]*0*(\d{1,3})(?!\d)"#,
    options: [.caseInsensitive]
)
private let weekRe = Regex.compile(
    #"(?:^|[^a-z])(?:week|wk)[\s_\-.]*0*(\d{1,2})(?!\d)"#,
    options: [.caseInsensitive]
)
private let moduleRe = Regex.compile(
    #"(?:^|[^a-z])(?:module|mod|unit|block|topic)[\s_\-.]*0*(\d{1,2})(?!\d)"#,
    options: [.caseInsensitive]
)
private let codeRe = Regex.compile(
    #"^([a-z])[\s.]?0*(\d{1,2})(?=[\s\-.]|$)"#,
    options: [.caseInsensitive]
)

private let toPat = #"\s*(?:-|–|—|&|\+|and|to)\s*"#
private let codeRangeRe = Regex.compile(
    #"^([a-z])[\s.]?0*(\d{1,2})"# + toPat + #"(?:([a-z])[\s.]?)?0*(\d{1,2})(?=[\s\-.]|$)"#,
    options: [.caseInsensitive]
)
private let lectureWordPat = #"(?:lectures?|lects?|lecs?|l)"#
private let lectureRangeRe = Regex.compile(
    #"(?:^|[^a-z])"# + lectureWordPat + #"[\s\-.]*0*(\d{1,3})"# + toPat + #"(?:"# + lectureWordPat + #"[\s\-.]*)?0*(\d{1,3})(?!\d|[\-.]\d)"#,
    options: [.caseInsensitive]
)
private let weekRangeRe = Regex.compile(
    #"(?:^|[^a-z])(?:weeks?|wks?)[\s\-.]*0*(\d{1,2})"# + toPat + #"(?:(?:weeks?|wks?)[\s\-.]*)?0*(\d{1,2})(?!\d|[\-.]\d)"#,
    options: [.caseInsensitive]
)
private let maxRange = 6

private let isoDateRe = Regex.compile(#"(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)"#)
private let dmyDateRe = Regex.compile(#"(?<!\d)(0?[1-9]|[12]\d|3[01])[-_.](0?[1-9]|1[0-2])[-_.](20\d{2}|\d{2})(?!\d)"#)

private let paperRe = Regex.compile(
    #"(?:past|sample|practice|mock|final|mid[\s_-]?sem(?:ester)?|deferred)[\s_\-]*(?:exam|paper|test)|exam[\s_\-]*(?:paper|questions)"#,
    options: [.caseInsensitive]
)
private let adminRe = Regex.compile(
    #"course[\s_\-]*(?:profile|outline)|syllabus|(?:^|[^a-z])ecp(?:[^a-z]|$)|assessment[\s_\-]*(?:guide|brief|task|info)|reading[\s_\-]*list|timetable|marking[\s_\-]*rubric"#,
    options: [.caseInsensitive]
)
private let noiseRe = Regex.compile(
    #"\b(?:transcripts?|captions?|subtitles?|slides?|slide[\s_-]?deck|deck|notes|lecture[\s_-]?notes|handouts?|recordings?|audio|video|echo360|lectopia|final|copy|print|printable|annotated|shared|combined|v\d+|\d+[\s_-]?per[\s_-]?page)\b"#,
    options: [.caseInsensitive]
)
private let courseCodeRe = Regex.compile(#"\b[a-z]{4}\d{4}\b"#, options: [.caseInsensitive])
private let parenNumRe = Regex.compile(#"\(\d+\)"#)
private let nonAlnumRe = Regex.compile(#"[^a-z0-9]+"#, options: [.caseInsensitive])
private let underscoresRe = Regex.compile(#"_+"#)
private let whitespaceRe = Regex.compile(#"\s+"#)
private let partNumberRe = Regex.compile(#"\b(?:part|pt)\.?\s*0*(\d{1,2})\b"#, options: [.caseInsensitive])
private let spacedDashOrColonRe = Regex.compile(#"\s+-+\s+|\s*[–—:]+\s*"#)
private let kebabHyphenRe = Regex.compile(#"(?<=[a-z0-9])-+(?=[a-z0-9])"#, options: [.caseInsensitive])
private let unevenSpacedHyphenRe = Regex.compile(#"\s+-+\s*|\s*-+\s+"#)
private let edgeDashesRe = Regex.compile(#"^[\s–-]+|[\s–-]+$"#)
private let hasLetterRe = Regex.compile(#"[a-z]"#, options: [.caseInsensitive])

private func plain(_ filename: String) -> String {
    let noExt = Regex.replaceFirst(extRe, in: filename, with: "")
    return Regex.replace(underscoresRe, in: noExt, with: " ")
}

public func stemOf(_ filename: String) -> String {
    var s = plain(filename)
    s = Regex.replace(courseCodeRe, in: s, with: " ")
    s = Regex.replace(noiseRe, in: s, with: " ")
    s = Regex.replace(parenNumRe, in: s, with: " ")
    s = Regex.replace(nonAlnumRe, in: s, with: " ")
    return s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

private func named(_ filename: String) -> String {
    Regex.replace(courseCodeRe, in: plain(filename), with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

public func titleFromFilename(_ filename: String) -> String {
    let noExt = Regex.replaceFirst(extRe, in: filename, with: "")
    let kebab = !Regex.test(whitespaceRe, in: noExt)
    var cleaned = named(filename)
    // In lib/group.ts, numbering/date regexes have no /g flag and only remove the first match,
    // so "Week 3 lecture, revisiting week 1" keeps "week 1".
    for re in [codeRangeRe, codeRe, lectureRangeRe, weekRangeRe, weekAndLectureRe, lectureRe, weekRe, moduleRe] {
        cleaned = Regex.replaceFirst(re, in: cleaned, with: " ")
    }
    cleaned = Regex.replace(noiseRe, in: cleaned, with: " ")
    cleaned = Regex.replaceFirst(isoDateRe, in: cleaned, with: " ")
    cleaned = Regex.replaceFirst(dmyDateRe, in: cleaned, with: " ")
    cleaned = Regex.replace(parenNumRe, in: cleaned, with: " ")
    cleaned = Regex.replace(partNumberRe, in: cleaned, with: "Part $1")
    cleaned = Regex.replace(spacedDashOrColonRe, in: cleaned, with: " – ")
    if kebab {
        cleaned = Regex.replace(kebabHyphenRe, in: cleaned, with: " ")
    }
    cleaned = Regex.replace(unevenSpacedHyphenRe, in: cleaned, with: " – ")
    cleaned = Regex.replace(whitespaceRe, in: cleaned, with: " ")
    cleaned = Regex.replace(edgeDashesRe, in: cleaned, with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if cleaned.isEmpty || !Regex.test(hasLetterRe, in: cleaned) { return "" }
    guard let first = cleaned.first else { return "" }
    return String(first).uppercased() + cleaned.dropFirst()
}

public func dateFromName(_ name: String) -> String? {
    if let iso = Regex.firstMatch(isoDateRe, in: name),
       let y = Regex.group(iso, at: 1, in: name),
       let m = Regex.group(iso, at: 2, in: name),
       let d = Regex.group(iso, at: 3, in: name) {
        return "\(y)-\(m)-\(d)"
    }
    if let dmy = Regex.firstMatch(dmyDateRe, in: name),
       let d = Regex.group(dmy, at: 1, in: name),
       let m = Regex.group(dmy, at: 2, in: name),
       let y = Regex.group(dmy, at: 3, in: name) {
        let year = y.utf16Count == 2 ? "20\(y)" : y
        let month = m.utf16Count == 1 ? "0\(m)" : m
        let day = d.utf16Count == 1 ? "0\(d)" : d
        return "\(year)-\(month)-\(day)"
    }
    return nil
}

private func localDay(_ d: Date, calendar: Calendar = .gregorian) -> String {
    let comps = calendar.dateComponents([.year, .month, .day], from: d)
    return String(format: "%04d-%02d-%02d", comps.year ?? 2026, comps.month ?? 1, comps.day ?? 1)
}

private struct LectureId: Equatable {
    var key: String
    var n: Int
    var label: String
}

private struct Keyed {
    var index: Int
    var file: GroupInput
    var filename: String
    var dirs: [String]
    var mod: (key: String, title: String, n: Int)?
    var lecture: LectureId?
    var range: [LectureId]?
    var shared: Bool
    var date: String?
    var stem: String
    var setAside: String?
}

private func span(_ lo: Int, _ hi: Int, make: (Int) -> LectureId) -> [LectureId]? {
    if !(hi > lo) || hi - lo >= maxRange { return nil }
    return (lo...hi).map(make)
}

private func codeId(_ letter: String, _ n: Int) -> LectureId {
    let L = letter.uppercased()
    let code = Int(L.unicodeScalars.first?.value ?? 65)
    return LectureId(key: "c\(L)\(n)", n: (code - 64) * 1000 + n, label: "\(L)\(n)")
}

private func lectureId(_ n: Int) -> LectureId {
    LectureId(key: "l\(n)", n: n, label: "L\(n)")
}

private func weekId(_ n: Int) -> LectureId {
    LectureId(key: "w\(n)", n: n * 100, label: "Week \(n)")
}

private func lectureFrom(_ filename: String, _ dirs: [String]) -> (lecture: LectureId?, range: [LectureId]?) {
    let name = named(filename)

    if let lr = Regex.firstMatch(lectureRangeRe, in: name),
       let a = Regex.group(lr, at: 1, in: name).flatMap(Int.init),
       let b = Regex.group(lr, at: 2, in: name).flatMap(Int.init) {
        return (nil, span(a, b, make: lectureId))
    }
    if let wr = Regex.firstMatch(weekRangeRe, in: name),
       let a = Regex.group(wr, at: 1, in: name).flatMap(Int.init),
       let b = Regex.group(wr, at: 2, in: name).flatMap(Int.init) {
        return (nil, span(a, b, make: weekId))
    }
    if let cr = Regex.firstMatch(codeRangeRe, in: name),
       let l1 = Regex.group(cr, at: 1, in: name),
       let a = Regex.group(cr, at: 2, in: name).flatMap(Int.init),
       let b = Regex.group(cr, at: 4, in: name).flatMap(Int.init) {
        let l2 = Regex.group(cr, at: 3, in: name)
        if l2 == nil || l2!.uppercased() == l1.uppercased() {
            return (nil, span(a, b) { codeId(l1, $0) })
        }
    }

    if let wl = Regex.firstMatch(weekAndLectureRe, in: name),
       let w = Regex.group(wl, at: 1, in: name).flatMap(Int.init),
       let l = Regex.group(wl, at: 2, in: name).flatMap(Int.init) {
        return (LectureId(key: "w\(w)l\(l)", n: w * 100 + l, label: "W\(w) L\(l)"), nil)
    }
    if let l = Regex.firstMatch(lectureRe, in: name),
       let n = Regex.group(l, at: 1, in: name).flatMap(Int.init) {
        return (lectureId(n), nil)
    }
    if let w = Regex.firstMatch(weekRe, in: name),
       let n = Regex.group(w, at: 1, in: name).flatMap(Int.init) {
        return (weekId(n), nil)
    }
    if let c = Regex.firstMatch(codeRe, in: name),
       let letter = Regex.group(c, at: 1, in: name),
       let n = Regex.group(c, at: 2, in: name).flatMap(Int.init) {
        return (codeId(letter, n), nil)
    }

    if let lastDir = dirs.last,
       let m = Regex.firstMatch(lectureRe, in: lastDir),
       let n = Regex.group(m, at: 1, in: lastDir).flatMap(Int.init) {
        return (lectureId(n), nil)
    }
    return (nil, nil)
}

private func describeFile(_ file: GroupInput, index: Int) -> Keyed {
    let parts = file.relativePath.components(separatedBy: CharacterSet(charactersIn: "/\\"))
    let filename = parts.last ?? file.relativePath
    let dirs = Array(parts.dropLast())

    var mod: (key: String, title: String, n: Int)? = nil
    for dir in dirs.reversed() {
        if let m = Regex.firstMatch(moduleRe, in: dir),
           let n = Regex.group(m, at: 1, in: dir).flatMap(Int.init) {
            let cleanDir = Regex.replace(underscoresRe, in: dir, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            mod = (key: "m\(n)", title: cleanDir, n: n)
            break
        }
    }
    if mod == nil,
       let m = Regex.firstMatch(moduleRe, in: filename),
       let n = Regex.group(m, at: 1, in: filename).flatMap(Int.init) {
        mod = (key: "m\(n)", title: "Module \(n)", n: n)
    }

    let (lecture, range) = lectureFrom(filename, dirs)
    let recorded = file.kind == "TRANSCRIPT" && file.measuredHours != nil
    let setAside: String?
    if !recorded && Regex.test(paperRe, in: filename) {
        setAside = "looks like a past exam paper"
    } else if Regex.test(adminRe, in: filename) {
        setAside = "looks like course admin, not a lecture"
    } else {
        setAside = nil
    }

    return Keyed(
        index: index,
        file: file,
        filename: filename,
        dirs: dirs,
        mod: mod,
        lecture: lecture,
        range: range,
        shared: false,
        date: dateFromName(plain(filename)),
        stem: stemOf(filename),
        setAside: setAside
    )
}

private func keyOf(_ k: Keyed) -> String {
    let scope = k.mod?.key ?? ""
    if let lec = k.lecture { return "\(scope)|\(lec.key)" }
    if let date = k.date { return "\(scope)|d\(date)" }
    if !k.stem.isEmpty { return "\(scope)|s\(k.stem)" }
    return "\(scope)|f\(k.index)"
}

public func groupFiles(_ files: [GroupInput]) -> [ProposedLecture] {
    let described = files.enumerated().map { describeFile($0.element, index: $0.offset) }
    var groupOrder: [String] = []
    var groups: [String: [Keyed]] = [:]
    var aside: [Keyed] = []
    var ranged: [Keyed] = []

    for k in described {
        if k.setAside != nil {
            aside.append(k)
            continue
        }
        if k.range != nil {
            ranged.append(k)
            continue
        }
        let key = keyOf(k)
        if groups[key] == nil { groupOrder.append(key) }
        groups[key, default: []].append(k)
    }

    for k in ranged {
        guard let range = k.range, !range.isEmpty else { continue }
        let scope = k.mod?.key ?? ""
        let ids = range.map(\.key)
        var homes = ids.map { "\(scope)|\($0)" }.filter { groups[$0] != nil }
        if homes.isEmpty {
            homes = groupOrder.filter { key in
                if let bar = key.firstIndex(of: "|") {
                    let suffix = String(key[key.index(after: bar)...])
                    return ids.contains(suffix)
                }
                return false
            }
        }
        if homes.isEmpty {
            let first = range[0]
            let last = range[range.count - 1]
            let own = LectureId(key: "r" + ids.joined(separator: "+"), n: first.n, label: "\(first.label)–\(last.label)")
            let ownKey = "\(scope)|\(own.key)"
            var copy = k
            copy.lecture = own
            if groups[ownKey] == nil { groupOrder.append(ownKey) }
            groups[ownKey, default: []].append(copy)
            continue
        }
        for home in homes {
            var copy = k
            copy.shared = true
            groups[home, default: []].append(copy)
        }
    }

    var lectures: [(lecture: ProposedLecture, sort0: Int, sort1: Int)] = groupOrder.compactMap { key in
        guard let members = groups[key], !members.isEmpty else { return nil }
        let nonShared = members.filter { !$0.shared }
        let own = nonShared.isEmpty ? members : nonShared
        let lead = own.first(where: { $0.file.kind == "TRANSCRIPT" }) ?? own[0]
        let titles = own.map { titleFromFilename($0.filename) }.filter { !$0.isEmpty }
        var best = ""
        for t in titles where t.utf16Count > best.utf16Count {
            best = t
        }

        let number = (lead.lecture?.key.hasPrefix("l") == true) ? lead.lecture?.n : nil
        let label = lead.lecture?.label
        let fallbackTitle: String
        if let number {
            fallbackTitle = "Lecture \(number)"
        } else {
            fallbackTitle = label ?? "Untitled lecture"
        }
        let title = best.isEmpty ? fallbackTitle : best

        let dated = own.compactMap(\.date).first
        let earliest = members.map(\.file.modifiedOn).min() ?? Date()
        let hours = members.compactMap(\.file.measuredHours).max() ?? 0

        let proposed = ProposedLecture(
            title: title,
            number: number,
            label: label,
            moduleTitle: lead.mod?.title,
            deliveredOn: dated ?? localDay(earliest),
            durationHours: hours > 0 ? hours : 1,
            fileIndexes: members.map(\.index).sorted(),
            setAside: nil
        )
        return (proposed, lead.mod?.n ?? 0, lead.lecture?.n ?? Int.max)
    }

    lectures.sort { a, b in
        if a.sort0 != b.sort0 { return a.sort0 < b.sort0 }
        if a.sort1 != b.sort1 { return a.sort1 < b.sort1 }
        if a.lecture.deliveredOn != b.lecture.deliveredOn {
            return a.lecture.deliveredOn.localizedCompare(b.lecture.deliveredOn) == .orderedAscending
        }
        return a.lecture.title.localizedCompare(b.lecture.title) == .orderedAscending
    }

    let setAsideList: [ProposedLecture] = aside.map { k in
        let t = titleFromFilename(k.filename)
        return ProposedLecture(
            title: t.isEmpty ? k.filename : t,
            number: nil,
            label: nil,
            moduleTitle: k.mod?.title,
            deliveredOn: k.date ?? localDay(k.file.modifiedOn),
            durationHours: k.file.measuredHours ?? 1,
            fileIndexes: [k.index],
            setAside: k.setAside
        )
    }

    return lectures.map(\.lecture) + setAsideList
}

public func lecturesFromSort(_ files: [GroupInput], _ sorted: SortedFolder) -> [ProposedLecture] {
    lecturesFromSort(files, sorted: sorted)
}

public func lecturesFromSort(_ files: [GroupInput], sorted: SortedFolder) -> [ProposedLecture] {
    let described = files.enumerated().map { describeFile($0.element, index: $0.offset) }
    var indexOf: [String: Int] = [:]
    for (i, f) in files.enumerated() {
        indexOf[f.relativePath] = i
    }
    var placed = Set<Int>()
    var lectures: [ProposedLecture] = []

    for l in sorted.lectures {
        var uniqueIndices: [Int] = []
        for p in l.files {
            if let idx = indexOf[p], !uniqueIndices.contains(idx) {
                uniqueIndices.append(idx)
            }
        }
        let members = uniqueIndices.map { described[$0] }
        if members.isEmpty { continue }
        for m in members { placed.insert(m.index) }

        let lead = members.first(where: { $0.file.kind == "TRANSCRIPT" }) ?? members[0]
        let dated = lead.date ?? members.compactMap(\.date).first
        let earliest = members.map(\.file.modifiedOn).min() ?? Date()
        let hours = members.compactMap(\.file.measuredHours).max() ?? 0

        let trimmedTitle = l.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let leadTitle = titleFromFilename(lead.filename)
        let finalTitle = !trimmedTitle.isEmpty ? trimmedTitle : (!leadTitle.isEmpty ? leadTitle : "Untitled lecture")

        let trimmedMod = l.module?.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalMod = (trimmedMod?.isEmpty == false) ? trimmedMod : lead.mod?.title

        lectures.append(
            ProposedLecture(
                title: finalTitle,
                number: (lead.lecture?.key.hasPrefix("l") == true) ? lead.lecture?.n : nil,
                label: lead.lecture?.label,
                moduleTitle: finalMod,
                deliveredOn: dated ?? localDay(earliest),
                durationHours: hours > 0 ? hours : 1,
                fileIndexes: members.map(\.index).sorted(),
                setAside: nil
            )
        )
    }

    var reasons: [Int: String] = [:]
    for s in sorted.setAside {
        if let idx = indexOf[s.file] {
            reasons[idx] = s.reason
        }
    }

    let aside: [ProposedLecture] = described
        .filter { !placed.contains($0.index) }
        .map { k in
            let t = titleFromFilename(k.filename)
            let reason = reasons[k.index]?.trimmingCharacters(in: .whitespacesAndNewlines)
            return ProposedLecture(
                title: t.isEmpty ? k.filename : t,
                number: nil,
                label: nil,
                moduleTitle: k.mod?.title,
                deliveredOn: k.date ?? localDay(k.file.modifiedOn),
                durationHours: k.file.measuredHours ?? 1,
                fileIndexes: [k.index],
                setAside: (reason?.isEmpty == false) ? reason! : "the AI didn't place this — tick it to import it on its own"
            )
        }

    return lectures + aside
}
