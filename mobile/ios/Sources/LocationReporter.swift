import Combine
import CoreLocation
import Foundation
import UIKit

/// Sends place changes to `POST /api/location/ping` with the phone's own owner token (header `X-OpenRhen-Owner`) and
/// its install id as `device`. Significant-change monitoring needs only "Always" permission. Whether iOS
/// relaunches the app for it is unverified on a phone (no background modes are set), so this object is
/// created at launch (see OpenRhenApp.init) in case it does.
/// The portal decides what a reading means; this only reports it. Coordinates are never logged.
///
/// A ping that fails to arrive is kept in an on-disk outbox (`PingOutbox`) and retried in order. Only live fixes go
/// to the ping route, so a ping older than five minutes is dropped rather than sent late. Nothing is sent while the
/// phone is not paired, and signing out empties the outbox.
final class LocationReporter: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var status = "Not signed in"
    private let manager = CLLocationManager()
    private let session: AppSession
    private let file: OutboxFile
    private var outbox: PingOutbox
    private var subscription: AnyCancellable?
    private var lastAccepted = Date.distantPast
    private var draining = false
    private var retryTask: Task<Void, Never>?

    /// How long to wait before retrying a ping the portal could not take.
    private static let retryDelay: UInt64 = 60 * 1_000_000_000

    init(session: AppSession, file: OutboxFile) {
        self.session = session
        self.file = file
        self.outbox = file.load()
        super.init()
        manager.delegate = self
        subscription = session.$auth.map { $0.session?.token }.removeDuplicates().sink { [weak self] _ in
            DispatchQueue.main.async { self?.apply() }
        }
    }

    private var signedIn: Bool { session.auth.session != nil }

    private func apply() {
        guard signedIn else {
            manager.stopMonitoringSignificantLocationChanges()
            retryTask?.cancel()
            outbox.removeAll()
            file.delete()
            status = "Not signed in"
            return
        }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestAlwaysAuthorization(); status = "Waiting for permission"
        case .authorizedAlways:
            manager.startMonitoringSignificantLocationChanges()
            status = "Reporting place changes"
            drain()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization(); status = "Needs Always permission (Settings > OpenRhen > Location)"
        default: status = "Location permission denied"
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        DispatchQueue.main.async { self.apply() }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix = locations.last else { return }
        Task { @MainActor in self.accept(fix) }
    }

    @MainActor
    private func accept(_ fix: CLLocation) {
        guard signedIn else { return }
        let now = Date()
        guard Policies.mayReport(now: now, lastSent: lastAccepted) else { return }
        lastAccepted = now
        outbox.enqueue(QueuedPing(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude,
                                  accuracyMeters: max(fix.horizontalAccuracy, 0), observedAt: fix.timestamp), now: now)
        file.save(outbox)
        drain()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { report("Location error") }

    /// Sends whatever is queued, oldest first. Called on a new fix, on coming to the foreground and after a retry delay.
    func drain() {
        Task { @MainActor in await self.drainQueue() }
    }

    @MainActor
    private func drainQueue() async {
        guard !draining, let device = session.auth.session else { return }
        draining = true
        retryTask?.cancel()
        var background = UIBackgroundTaskIdentifier.invalid
        background = UIApplication.shared.beginBackgroundTask { UIApplication.shared.endBackgroundTask(background) }
        defer {
            draining = false
            if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
        }
        let installId = session.installId
        while true {
            guard let ping = outbox.next(now: Date()) else { break }
            let disposition = await session.api.sendPing(origin: device.origin, token: device.token, installId: installId, ping: ping)
            // The phone may have been signed out, or paired again, while the request was in flight.
            guard session.auth.session?.token == device.token else { return }
            switch outbox.apply(disposition) {
            case .continueDraining:
                file.save(outbox)
                if disposition == .sent { status = "Last report sent" }
            case .retryLater:
                status = "Waiting to retry (\(outbox.count) queued)"
                scheduleRetry()
                return
            case .signedOut:
                file.delete()
                session.tokenRejected(device.token)
                return
            }
        }
        file.save(outbox)
    }

    @MainActor
    private func scheduleRetry() {
        retryTask?.cancel()
        retryTask = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: LocationReporter.retryDelay) } catch { return }
            self.drain()
        }
    }

    private func report(_ text: String) { DispatchQueue.main.async { self.status = text } }
}
