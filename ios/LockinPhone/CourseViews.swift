import LockinKit
import PhotosUI
import SwiftUI

/// Every course as a card, two to a row; a card opens that course's lectures.
struct CoursesTab: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""
    @State private var photoFor: String?
    @State private var picking = false
    @State private var picked: PhotosPickerItem?

    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        NavigationStack {
            ScrollView {
                if model.snapshot == nil {
                    Group {
                        if model.syncing {
                            ProgressView(model.syncStatus ?? "Syncing…")
                        } else {
                            Text(model.syncError ?? "Pull down to sync with \(model.pairing?.computer ?? "your computer").")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 40)
                    .padding(.horizontal)
                }
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(model.courses.filter(matches)) { course in
                        NavigationLink(value: Route.course(course.id)) {
                            CourseCard(course: course)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button {
                                photoFor = course.id
                                picking = true
                            } label: {
                                Label(model.coursePhoto(course.id) == nil ? "Add a cover photo" : "Change cover photo", systemImage: "photo")
                            }
                            if model.coursePhoto(course.id) != nil {
                                Button(role: .destructive) {
                                    model.removeCoursePhoto(course.id)
                                } label: {
                                    Label("Remove cover photo", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .navigationTitle("Courses")
            .searchable(text: $search, prompt: "Search courses")
            .refreshable { await model.sync() }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { SyncBadge() } }
            .photosPicker(isPresented: $picking, selection: $picked, matching: .images)
            .onChange(of: picked) { _, item in
                guard let item, let courseId = photoFor else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        model.setCoursePhoto(courseId, data: data)
                    }
                    picked = nil
                    photoFor = nil
                }
            }
            .lockinRoutes()
        }
    }

    private func matches(_ course: Course) -> Bool {
        let q = search.trimmingCharacters(in: .whitespaces)
        return q.isEmpty || course.code.localizedCaseInsensitiveContains(q) || course.title.localizedCaseInsensitiveContains(q)
    }
}

/// A course's card: its cover photo, or its own colour, with its code and title.
struct CourseCard: View {
    @Environment(AppModel.self) private var model
    let course: Course

    var body: some View {
        let lectures = model.lectures(in: course.id)
        let due = lectures.reduce(0) { $0 + model.dueCount(for: $1.id) }
        ZStack(alignment: .bottomLeading) {
            background
            LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 2) {
                Text(course.code)
                    .font(.headline.weight(.bold))
                Text(course.title)
                    .font(.caption)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text("\(lectures.count) lecture\(lectures.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .opacity(0.85)
            }
            .foregroundStyle(.white)
            .padding(12)
        }
        .overlay(alignment: .topTrailing) {
            if due > 0 {
                Text("\(due) due")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(.ultraThinMaterial))
                    .padding(8)
            }
        }
        .aspectRatio(1.3, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 3)
        .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var background: some View {
        if let photo = model.coursePhoto(course.id) {
            Color.clear.overlay {
                Image(uiImage: photo).resizable().scaledToFill()
            }
            .clipped()
        } else {
            LinearGradient(colors: [tone, tone.opacity(0.7)], startPoint: .topLeading, endPoint: .bottomTrailing)
                .overlay(alignment: .topLeading) {
                    Image(systemName: "books.vertical.fill")
                        .font(.title2)
                        .foregroundStyle(.white.opacity(0.35))
                        .padding(12)
                }
        }
    }

    /// Each course keeps the same colour, picked from its code.
    private var tone: Color {
        let palette: [Color] = [.blue, .purple, .pink, .orange, .teal, .indigo, .green, .red, .cyan, .brown]
        let sum = course.code.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        return palette[sum % palette.count]
    }
}

/// One course's lectures, in the order chosen.
struct CourseView: View {
    @Environment(AppModel.self) private var model
    let courseId: String
    @AppStorage("lectureOrder") private var orderRaw = LectureOrder.newest.rawValue
    @State private var search = ""
    @State private var picking = false
    @State private var picked: PhotosPickerItem?

    var body: some View {
        let order = LectureOrder(rawValue: orderRaw) ?? .newest
        let lectures = sortLectures(model.lectures(in: courseId).filter(matches), by: order) { model.standing(of: $0) }
        List {
            if lectures.isEmpty {
                Text(search.isEmpty ? "No lectures in this course yet." : "No lectures match.").foregroundStyle(.secondary)
            }
            Section {
                ForEach(lectures) { lecture in
                    NavigationLink(value: Route.lecture(lecture.id)) { LectureRow(lecture: lecture) }
                }
            } header: {
                if !lectures.isEmpty { Label(order.label, systemImage: order.symbol) }
            }
        }
        .navigationTitle(model.course(courseId)?.code ?? "Course")
        .searchable(text: $search, prompt: "Search lectures")
        .refreshable { await model.sync() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Order", selection: $orderRaw) {
                        ForEach(LectureOrder.allCases) { option in
                            Label(option.label, systemImage: option.symbol).tag(option.rawValue)
                        }
                    }
                    Section {
                        Button {
                            picking = true
                        } label: {
                            Label(model.coursePhoto(courseId) == nil ? "Add a cover photo" : "Change cover photo", systemImage: "photo")
                        }
                        if model.coursePhoto(courseId) != nil {
                            Button(role: .destructive) {
                                model.removeCoursePhoto(courseId)
                            } label: {
                                Label("Remove cover photo", systemImage: "trash")
                            }
                        }
                    }
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                }
                .accessibilityLabel("Sort and course options")
            }
        }
        .photosPicker(isPresented: $picking, selection: $picked, matching: .images)
        .onChange(of: picked) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    model.setCoursePhoto(courseId, data: data)
                }
                picked = nil
            }
        }
    }

    private func matches(_ lecture: Lecture) -> Bool {
        let q = search.trimmingCharacters(in: .whitespaces)
        return q.isEmpty || lecture.title.localizedCaseInsensitiveContains(q)
            || (lecture.module?.localizedCaseInsensitiveContains(q) ?? false)
    }
}
