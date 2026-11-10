import Combine
import Foundation
import UIKit

/// The phone as a sensor: records each time iOS wakes the app, posts the alive signal, reads Health into physiology rows
/// and sends the queue to `POST /api/activity-events` with the phone's own owner token. All decisions are in the pure
/// files (`HealthRows`, `SensorState`, `SensorWords`); this object only does the I/O and publishes the results. Every
/// mutating method runs on the main actor.
///
/// What it does not send, and why: location fixes, motion and phone events have no place on the server to go yet (the
/// families they need are not published there), so they are not collected or queued. Live place changes still go to
/// the location ping (`LocationReporter`).
final class SensorCenter: ObservableObject {
    @Published private(set) var state: SensorState
    @Published private(set) var healthStatus = "Not started"
    @Published private(set) var backgroundNote: String?

    private let session: AppSession
    private let file: PrivateJSONFile<SensorState>
    private let reader = HealthReader()
    private var subscription: AnyCancellable?
    private var draining = false
    private var reading = false
    private var observing = false
    private var retryTask: Task<Void, Never>?

    init(session: AppSession, directory: URL) {
        let file = PrivateJSONFile<SensorState>(directory: directory, name: "sensor-queue.json")
        self.session = session
        self.file = file
        var loaded = session.auth.session == nil ? SensorState() : (file.load() ?? SensorState())
        // A request that was in the air when the app last stopped is gone; its rows are still queued.
        loaded.clearInFlight()
        self.state = loaded
        subscription = session.$auth.map { $0.session?.token }.removeDuplicates().dropFirst().sink { [weak self] _ in
            Task { @MainActor [weak self] in self?.sessionChanged() }
        }
        if session.auth.session == nil { file.delete() }
    }

    private var signedIn: Bool { session.auth.session != nil }

    /// The phone's offset from UTC at `date`, in minutes east.
    private static func offset(at date: Date) -> Int { TimeZone.current.secondsFromGMT(for: date) / 60 }

    @MainActor
    private func sessionChanged() {
        retryTask?.cancel()
        state = SensorState()
        healthStatus = "Not started"
        file.delete()
        if signedIn { appBecameActive() }
    }

    @MainActor
    private func save() { file.save(state) }

    // MARK: Wakes

    /// iOS woke the app (a place change, or new Health data), or it was opened. Records the wake, builds the alive
    /// signal and sends what is waiting. A background wake also reads Health, since the phone may be unlocked.
    @MainActor
    func wake(_ kind: WakeKind) {
        guard signedIn else { return }
        let background = UIApplication.shared.applicationState != .active
        state.wakes.record(kind, at: Date(), background: background)
        queueHeartbeat()
        save()
        drain()
        if kind == .location && background { Task { await self.syncHealth() } }
    }

    /// The app came to the front: the alive signal, a Health read and a send. Not a wake in iOS's sense, so not recorded.
    @MainActor
    func appBecameActive() {
        guard signedIn else { return }
        queueHeartbeat()
        save()
        drain()
        Task {
            await self.startObserving()
            await self.syncHealth()
        }
    }

    @MainActor
    private func queueHeartbeat() {
        guard let device = SensorDevice.label(fromInstallId: session.installId) else { return }
        state.planHeartbeat(device: device, now: Date())
    }

    // MARK: Health

    @MainActor
    private func startObserving() async {
        guard !observing, HealthReader.isAvailable, HealthSettings.enabled else { return }
        observing = true
        let refused = await reader.startObserving { [weak self] in
            Task { @MainActor [weak self] in self?.wake(.health) }
        }
        backgroundNote = refused == nil ? nil : SensorWords.healthBackgroundRefused
    }

    /// Reads Health from the last good read (a little earlier, so a late Watch sync lands) and queues new or changed rows.
    @MainActor
    func syncHealth() async {
        guard signedIn, !reading else { return }
        guard HealthSettings.enabled else { healthStatus = SensorWords.healthOff; return }
        guard HealthReader.isAvailable else { healthStatus = SensorWords.healthNotAvailable; return }
        guard let device = SensorDevice.label(fromInstallId: session.installId) else { return }
        reading = true
        defer { reading = false }
        let token = session.auth.session?.token
        do {
            try await reader.requestAccess()
            let now = Date()
            let window = HealthSyncPlan.window(lastGoodRead: state.healthReadThrough, now: now)
            let read = try await reader.read(window: window)
            guard session.auth.session?.token == token else { return }
            let rows: [PlannedRow] = HealthRows.steps(read.steps, now: now, offset: SensorCenter.offset)
                + HealthRows.heartRate(read.heartRate, now: now, offset: SensorCenter.offset)
                + HealthRows.heartRateVariability(read.variability, now: now, offset: SensorCenter.offset)
                + HealthRows.sleep(read.sleep, now: now, offset: SensorCenter.offset)
            let queued = state.plan(rows, device: device, now: now)
            state.healthReadThrough = now
            save()
            healthStatus = SensorWords.healthRead(at: now, queued: queued, zone: TimeZone.current) + " " + SensorWords.healthNoAnswerNote
            drain()
        } catch {
            healthStatus = SensorWords.healthReadFailed
        }
    }

    // MARK: Sending

    /// Sends whatever is queued, in batches. Called after every change to the queue, on a retry and on pull to refresh.
    @MainActor
    func drain() {
        Task { await self.drainQueue() }
    }

    @MainActor
    func refresh() async {
        await syncHealth()
        await drainQueue()
    }

    @MainActor
    func clearSetAside() {
        state.clearSetAside()
        save()
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
            switch state.nextBatch(now: Date()) {
            case .nothing:
                save()
                return
            case .wait(let until):
                save()
                scheduleRetry(at: until)
                return
            case .send(let batch):
                let reply = await session.api.sendSensorBatch(origin: device.origin, token: device.token, installId: installId, events: batch)
                // The phone may have been signed out, or paired again, while the request was in flight.
                guard session.auth.session?.token == device.token else { return }
                switch state.apply(reply, sent: batch, now: Date()) {
                case .continueDraining:
                    save()
                case .retryLater:
                    save()
                    if let until = state.notBefore { scheduleRetry(at: until) }
                    return
                case .signedOut:
                    file.delete()
                    session.tokenRejected(device.token)
                    return
                }
            }
        }
    }

    @MainActor
    private func scheduleRetry(at date: Date) {
        retryTask?.cancel()
        let seconds = max(date.timeIntervalSinceNow, 1)
        retryTask = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } catch { return }
            self.drain()
        }
    }
}

/// The one in-app setting for Health: send it or not. On by default, since reading still needs the person's yes in iOS's own sheet.
enum HealthSettings {
    static let key = "sendHealth"

    static var enabled: Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }
}
