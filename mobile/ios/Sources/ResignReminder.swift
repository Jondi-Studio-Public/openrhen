import Foundation
import UserNotifications

/// Free-signed builds stop launching 7 days after install. A local notification at day 6 reminds
/// the user to re-sign. UNVERIFIED on a phone: the install date is the app bundle's creation date,
/// which should reset on a re-sign. It is cross-checked against a first-launch date kept in
/// UserDefaults (which survives a re-sign), taking the newer, so an unreadable bundle date
/// degrades to "first launch" rather than "now on every launch".
enum ResignReminder {
    static let identifier = "resign-reminder"
    static let lifetime: TimeInterval = 7 * 86_400
    static let leadTime: TimeInterval = 1 * 86_400
    private static let firstLaunchKey = "firstLaunchDate"

    static var installDate: Date {
        let defaults = UserDefaults.standard
        let now = Date()
        let stored = defaults.object(forKey: firstLaunchKey) as? Date
        let bundle = (try? Bundle.main.bundleURL.resourceValues(forKeys: [.creationDateKey]).creationDate)
            .flatMap { $0 <= now ? $0 : nil }
        if stored == nil { defaults.set(bundle ?? now, forKey: firstLaunchKey) }
        return [stored, bundle].compactMap { $0 }.max() ?? now
    }

    static func schedule() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            center.removePendingNotificationRequests(withIdentifiers: [identifier])
            let fire = max(installDate.addingTimeInterval(lifetime - leadTime).timeIntervalSinceNow, 60)
            let content = UNMutableNotificationContent()
            content.title = "Re-sign OpenRhen"
            content.body = "The app stops opening tomorrow. Re-sign it from your PC."
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: fire, repeats: false)
            center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
        }
    }

    static func summary() -> String {
        let installed = installDate
        let expires = installed.addingTimeInterval(lifetime)
        return "Signed \(installed.formatted(date: .abbreviated, time: .shortened)); stops opening about \(expires.formatted(date: .abbreviated, time: .omitted)). You get a reminder a day before."
    }
}
