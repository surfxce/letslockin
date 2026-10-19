import AppKit
import UserNotifications
import LockinCore

// Port of electron/main.ts's reminder side: the badge is the quiet reminder and shows
// whether or not notifications are on; a notification goes out for each lecture due for
// LAQs, one a day per lecture, between 8am and 10pm. Checked every five minutes and
// whenever anything in the database changes, so it is right without waiting out the
// timer.

/// Answers for a notification's click (`n.on("click")`), which opens the lecture.
final class ReminderClickHandler: NSObject, UNUserNotificationCenterDelegate {
    /// Set by the app before launch finishes; the daemon hands it the store.
    static weak var store: AppStore?

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let lectureId = response.notification.request.content.userInfo["lectureId"] as? String {
            Task { @MainActor in
                NSApp.activate(ignoringOtherApps: true)
                ReminderClickHandler.store?.selectedLectureId = lectureId
            }
        }
        completionHandler()
    }

    /// Show banners even while Lockin is frontmost, as Electron's notifications do.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

@MainActor
@Observable
final class ReminderDaemon {
    /// lectureId → the day it was last announced (`announced` in checkReminders).
    private var announced: [String: String] = [:]
    private var timer: Timer?
    private unowned let store: AppStore

    /// The notification centre only exists for a bundled app; a bare `swift run`
    /// binary has none and touching it throws. Reminders then wait for the real app.
    static var notificationsAvailable: Bool {
        Bundle.main.bundleIdentifier != nil
    }

    init(store: AppStore) {
        self.store = store
    }

    func start() {
        guard Self.notificationsAvailable else { return }
        UNUserNotificationCenter.current().delegate = sharedClickHandler
        let daemon = self
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
            Task { @MainActor in daemon.check() }
        }
        // Right after sleep, and right now: the timer alone misses a laptop asleep at
        // the hour a lecture came due.
        NotificationCenter.default.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in daemon.check() }
        }
        check()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// One round: the badge always, a notification when the hour and the settings allow.
    func check() {
        guard Self.notificationsAvailable else { return }
        let now = Date()
        let due = store.dueRows.filter { $0.dueAt != nil }.map(DueLecture.init(row:))

        // The dock badge is the quiet reminder; it shows whether or not notifications are on.
        let count = reminderBadgeCount(due: due)
        NSApp.dockTile.badgeLabel = count > 0 ? "\(count)" : nil

        let fresh = lecturesToAnnounce(
            due: due,
            announced: announced,
            notify: store.settings.notify,
            now: now
        )
        guard !fresh.isEmpty else { return }
        let content = reminderContent(fresh)
        let body = UNMutableNotificationContent()
        body.title = content.title
        body.body = content.body
        body.sound = .default
        // One lecture's notification opens its page; the round's id is stable so a
        // re-check within the day cannot post it again — the announced map is what keeps
        // that, and the identifier only keeps the banner unique.
        body.userInfo = fresh.count == 1 ? ["lectureId": fresh[0].lectureId] : [:]
        let request = UNNotificationRequest(
            identifier: "lockin.due.\(reminderDayKey(now)).\(fresh.map(\.lectureId).joined(separator: ".").hashedPrefix)",
            content: body,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
        announced = announcedAfter(announced, fresh: fresh, now: now)
    }
}

private let sharedClickHandler = ReminderClickHandler()

private extension String {
    /// Keeps a notification identifier inside UNUserNotificationCenter's 64-character
    /// budget when many lectures are due at once.
    var hashedPrefix: String {
        String(prefix(24))
    }
}
