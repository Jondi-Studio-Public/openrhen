import Foundation
import UserNotifications

/// Free-signed builds stop launching 7 days after install. A local notification at day 6 reminds
/// the user to re-sign. UNVERIFIED on a phone: the install date is the app bundle's creation date,
/// which should reset on a re-sign. It is cross-checked against a first-launch date kept in
/// UserDefaults (which survives a re-sign), taking the newer, so an unreadable bundle date
/// degrades to "first launch" rather than "now on every launch".
enum ResignReminder {
    static let identifier = "resign-reminder"
    private static let firstLaunchKey = "firstLaunchDate"

    static var installDate: Date {
        let defaults = UserDefaults.standard
        let now = Date()
        let stored = defaults.object(forKey: firstLaunchKey) as? Date
        let bundle = (try? Bundle.main.bundleURL.resourceValues(forKeys: [.creationDateKey]).creationDate)
        if stored == nil { defaults.set(Policies.firstLaunchToRecord(bundle: bundle, now: now), forKey: firstLaunchKey) }
        return Policies.installDate(stored: stored, bundle: bundle, now: now)
    }

    static func schedule() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            // Past the reminder time it fires once and is not scheduled again; a re-sign makes it due again.
            guard let fire = Policies.reminderDelay(installDate: installDate, now: Date()) else { return }
            center.removePendingNotificationRequests(withIdentifiers: [identifier])
            let content = UNMutableNotificationContent()
            content.title = "Re-sign OpenRhen"
            content.body = "The app stops opening tomorrow. Re-sign it from your PC."
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: fire, repeats: false)
            center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
        }
    }

    static func summary() -> String {
        let installed = installDate
        let expires = installed.addingTimeInterval(Policies.signingLifetime)
        return "Signed \(installed.formatted(date: .abbreviated, time: .shortened)); stops opening about \(expires.formatted(date: .abbreviated, time: .omitted)). A reminder fires a day before if the app is opened earlier than that."
    }
}
