import LockinKit
import SwiftUI

@main
struct LockinPhoneApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.lockinAccent)
        }
    }
}

extension Color {
    /// Lockin's blue, as on the computer.
    static let lockinAccent = Color(red: 0.137, green: 0.514, blue: 0.886)
}

/// Where a tap goes.
enum Route: Hashable {
    /// A course's lectures.
    case course(String)
    case lecture(String)
    /// Answering a sitting of this lecture: the open one, or a new one.
    case sitting(lectureId: String)
    /// A handed-in sitting: lecture and sitting ids.
    case result(lectureId: String, sittingId: String)
    /// AK review: one lecture's deck, or every deck's due cards.
    case review(String?)
    /// Setting a new exam; the exam being sat; one handed in.
    case examSetup
    case examSitting
    case examResult(String)
    /// Setting a new viva; the one being held; one handed in.
    case vivaSetup
    case vivaRoom
    case vivaResult(String)
    /// A clinical case, to start (or carry on with) as a viva.
    case caseRun(String)
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var phase
    @State private var linkMessage: String?

    var body: some View {
        Group {
            if model.pairing == nil {
                WelcomeView()
            } else {
                TabView {
                    CoursesTab()
                        .tabItem { Label("Courses", systemImage: "square.grid.2x2") }
                    DecksTab()
                        .tabItem { Label("AK", systemImage: "rectangle.on.rectangle.angled") }
                        .badge(model.dueCount())
                    ExamTab()
                        .tabItem { Label("Exam", systemImage: "checklist") }
                    ComputerTab()
                        .tabItem { Label(model.pairing?.computer ?? "Computer", systemImage: "laptopcomputer.and.iphone") }
                        .badge(model.unsentCount)
                }
            }
        }
        .onChange(of: phase) { _, now in
            if now == .active { Task { await model.syncIfStale() } }
        }
        .task { await model.syncIfStale() }
        // A pairing code opened from the Camera app.
        .onOpenURL { url in
            Task {
                let problem = await model.pair(with: url.absoluteString)
                linkMessage = problem ?? "Paired with \(model.pairing?.computer ?? "your computer")."
            }
        }
        .alert(linkMessage ?? "", isPresented: Binding(get: { linkMessage != nil }, set: { if !$0 { linkMessage = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }
}

/// Shows where a Route leads, for every NavigationStack in the app.
struct RouteDestination: ViewModifier {
    func body(content: Content) -> some View {
        content.navigationDestination(for: Route.self) { route in
            switch route {
            case .course(let id): CourseView(courseId: id)
            case .lecture(let id): LectureView(lectureId: id)
            case .sitting(let lectureId): SittingView(lectureId: lectureId)
            case .result(let lectureId, let sittingId): SittingResultView(lectureId: lectureId, sittingId: sittingId)
            case .review(let lectureId): ReviewView(lectureId: lectureId)
            case .examSetup: ExamSetupView()
            case .examSitting: ExamSittingView()
            case .examResult(let id): ExamResultView(examId: id)
            case .vivaSetup: VivaSetupView()
            case .vivaRoom: VivaRoomView()
            case .vivaResult(let id): VivaResultView(vivaId: id)
            case .caseRun(let id): CaseStartView(caseId: id)
            }
        }
    }
}

extension View {
    func lockinRoutes() -> some View { modifier(RouteDestination()) }
}
