import LockinKit
import SwiftUI

/// Every AK deck, with how many cards are due now.
struct DecksTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let decks = (model.snapshot?.lectures ?? []).filter { !model.cards(for: $0.id).isEmpty }
                List {
                    if decks.isEmpty {
                        ContentUnavailableView("No AK decks yet", systemImage: "rectangle.on.rectangle.angled",
                                               description: Text("Generate a deck for a lecture in Lockin on your computer, then sync."))
                    } else {
                        let due = model.dueCount(now: context.date)
                        Section {
                            NavigationLink(value: Route.review(nil)) {
                                Label(due == 0 ? "You're caught up" : "Review all due · \(due) card\(due == 1 ? "" : "s")",
                                      systemImage: due == 0 ? "checkmark.circle" : "play.circle.fill")
                            }
                            .disabled(due == 0)
                        } footer: {
                            Text("Reviews are saved on this phone and sent to your computer at the next sync.")
                        }
                        ForEach(model.courses) { course in
                            let inCourse = decks.filter { $0.courseId == course.id }
                            if !inCourse.isEmpty {
                                Section("\(course.code) · \(course.title)") {
                                    ForEach(inCourse) { lecture in
                                        NavigationLink(value: Route.review(lecture.id)) {
                                            DeckRow(lecture: lecture, now: context.date)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("AK")
            .refreshable { await model.sync() }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { SyncBadge() } }
            .lockinRoutes()
        }
    }
}

private struct DeckRow: View {
    @Environment(AppModel.self) private var model
    let lecture: Lecture
    let now: Date

    var body: some View {
        let cards = model.cards(for: lecture.id)
        let due = dueCards(cards, now: now).count
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text("L\(lecture.ordinal) · \(lecture.title)").lineLimit(2)
                Text("\(cards.count) card\(cards.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if due > 0 {
                Text("\(due)").font(.callout.monospacedDigit().weight(.semibold)).foregroundStyle(.tint)
            }
        }
    }
}

/// Inside a lecture: its deck at a glance.
struct DeckSummary: View {
    @Environment(AppModel.self) private var model
    let lecture: Lecture

    var body: some View {
        let cards = model.cards(for: lecture.id)
        let due = model.dueCount(for: lecture.id)
        List {
            if cards.isEmpty {
                Text("No AK deck for this lecture yet. Generate one in Lockin on your computer, then sync.")
                    .foregroundStyle(.secondary)
            } else {
                NavigationLink(value: Route.review(lecture.id)) {
                    Label(due == 0 ? "Caught up · \(cards.count) cards" : "Review \(due) due card\(due == 1 ? "" : "s")",
                          systemImage: due == 0 ? "checkmark.circle" : "play.circle.fill")
                }
                .disabled(due == 0)
                if due == 0, let next = nextDue(cards) {
                    Text("Next review \(next.formatted(.relative(presentation: .named))).").foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// Reviewing cards: think of the answer, reveal it, say how well you knew it.
struct ReviewView: View {
    @Environment(AppModel.self) private var model
    /// One lecture's deck, or every deck when nil.
    let lectureId: String?
    @State private var revealed = false
    @State private var reviewed = 0

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            let cards = model.cards(for: lectureId)
            let due = dueCards(cards, now: context.date)
            VStack(spacing: 0) {
                if let card = due.first {
                    HStack {
                        Text(card.state == "new" ? "New card" : card.state == "learning" ? "Learning" : "Review")
                        Spacer()
                        Text("\(due.count) ready · \(reviewed) reviewed")
                    }
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                    .padding(.top, 8)
                    HTMLView(html: page(card), images: model.images)
                        .id(card.id + (revealed ? "-back" : "-front"))
                    controls(card)
                        .padding()
                        .background(.bar)
                } else {
                    ContentUnavailableView {
                        Label("You're caught up", systemImage: "checkmark.circle")
                    } description: {
                        if let next = nextDue(cards, now: context.date) {
                            Text("Next review \(next.formatted(.relative(presentation: .named))).")
                        } else {
                            Text("No cards due.")
                        }
                    }
                }
            }
        }
        .navigationTitle(lectureId.flatMap { model.lecture($0) }.map { "L\($0.ordinal) · AK" } ?? "AK review")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func page(_ card: Card) -> String {
        var html = "<div class=\"eyebrow\">Question</div>\(card.frontHtml)"
        if revealed { html += "<div class=\"ak-answer\"><div class=\"eyebrow\">Answer</div>\(card.backHtml)</div>" }
        return html
    }

    @ViewBuilder
    private func controls(_ card: Card) -> some View {
        if !revealed {
            Button {
                revealed = true
            } label: {
                Text("Show answer").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        } else {
            VStack(spacing: 8) {
                Text("How well did you remember?").font(.caption).foregroundStyle(.secondary)
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(Rating.allCases) { rating in
                        Button {
                            model.review(card, rating)
                            reviewed += 1
                            revealed = false
                        } label: {
                            VStack(spacing: 2) {
                                Text(rating.label).font(.callout.weight(.medium))
                                Text(intervalLabel(card.scheduled(rating).intervalDays)).font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                        }
                        .buttonStyle(.bordered)
                        .tint(ratingColor(rating))
                    }
                }
            }
        }
    }

    private func ratingColor(_ rating: Rating) -> Color {
        switch rating {
        case .missed: return .red
        case .little: return .orange
        case .bit: return .blue
        case .gotIt: return .green
        }
    }
}
