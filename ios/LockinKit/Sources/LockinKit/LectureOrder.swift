import Foundation

/// How a course's lectures are listed.
public enum LectureOrder: String, CaseIterable, Identifiable, Sendable {
    case newest
    case oldest
    case weakest
    case strongest
    case mostDrilled
    case leastDrilled

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .newest: return "Latest lecture first"
        case .oldest: return "First lecture first"
        case .weakest: return "Weakest LAQs first"
        case .strongest: return "Strongest LAQs first"
        case .mostDrilled: return "Most drilled"
        case .leastDrilled: return "Least drilled"
        }
    }

    public var symbol: String {
        switch self {
        case .newest: return "arrow.down"
        case .oldest: return "arrow.up"
        case .weakest: return "chart.line.downtrend.xyaxis"
        case .strongest: return "chart.line.uptrend.xyaxis"
        case .mostDrilled: return "flame"
        case .leastDrilled: return "leaf"
        }
    }
}

/// How a lecture stands: its LAQ score (nil before a sitting is marked) and how many
/// sittings it has had.
public struct LectureStanding: Hashable, Sendable {
    public var score: Double?
    public var drills: Int

    public init(score: Double?, drills: Int) {
        self.score = score
        self.drills = drills
    }
}

/// Lectures in the chosen order. Lectures with no score yet come after scored ones in
/// both score orders; ties go by lecture number.
public func sortLectures(_ lectures: [Lecture], by order: LectureOrder,
                         standing: (Lecture) -> LectureStanding) -> [Lecture] {
    let rows = lectures.map { (lecture: $0, standing: standing($0)) }
    let sorted: [(lecture: Lecture, standing: LectureStanding)]
    switch order {
    case .newest:
        sorted = rows.sorted { $0.lecture.ordinal > $1.lecture.ordinal }
    case .oldest:
        sorted = rows.sorted { $0.lecture.ordinal < $1.lecture.ordinal }
    case .weakest, .strongest:
        let scored = rows.filter { $0.standing.score != nil }.sorted { a, b in
            let (x, y) = (a.standing.score ?? 0, b.standing.score ?? 0)
            if x != y { return order == .weakest ? x < y : x > y }
            return a.lecture.ordinal < b.lecture.ordinal
        }
        let unscored = rows.filter { $0.standing.score == nil }.sorted { $0.lecture.ordinal < $1.lecture.ordinal }
        sorted = scored + unscored
    case .mostDrilled, .leastDrilled:
        sorted = rows.sorted { a, b in
            if a.standing.drills != b.standing.drills {
                return order == .mostDrilled ? a.standing.drills > b.standing.drills : a.standing.drills < b.standing.drills
            }
            return a.lecture.ordinal < b.lecture.ordinal
        }
    }
    return sorted.map(\.lecture)
}
