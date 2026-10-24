import Foundation

public enum GeometricMeanError: Error, LocalizedError, Equatable {
    case emptyInput
    case invalidMarks([Double])

    public var errorDescription: String? {
        switch self {
        case .emptyInput:
            return "geometricMean needs at least one mark"
        case .invalidMarks(let marks):
            return "geometricMean needs non-negative finite marks, got \(marks)"
        }
    }
}

/// The geometric mean is the whole point of the scoring system: averaging 0 and 10
/// gives 5, which flatters an answer that would have scored nothing in the exam.
/// Multiplying and taking the nth root does not.
public func geometricMean(_ marks: [Double]) throws -> Double {
    if marks.isEmpty {
        throw GeometricMeanError.emptyInput
    }
    if marks.contains(where: { !$0.isFinite || $0 < 0 }) {
        throw GeometricMeanError.invalidMarks(marks)
    }
    // A single zero zeroes the attempt. That is the behaviour, not an edge case.
    if marks.contains(0) { return 0 }

    // Direct product rather than log-space: marks are 0-10 and n is small, so there
    // is no overflow risk, and exp(log(...)) would return 6.000000000000001 for [4, 9].
    let product = marks.reduce(1.0, *)
    return pow(product, 1.0 / Double(marks.count))
}

/// Displayed value. Store the raw one; round only at the edge.
public func roundMark(_ value: Double, dp: Int = 2) -> Double {
    let factor = pow(10.0, Double(dp))
    return (value * factor).rounded() / factor
}
