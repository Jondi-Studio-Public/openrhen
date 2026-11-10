import Combine
import Foundation
import UIKit

/// The live day: the cached client view, the refresh loop (event stream, with polling as the safety net), the
/// check-in "shown" report and the on-device command outbox. All decisions are in the pure files; this object only
/// does the I/O and publishes the results. Every mutating method runs on the main actor.
///
/// The server does expose an event stream (`GET /api/events`: a `hello` on connect and a `changed` per change); it
/// carries no payload, so each event just triggers a conditional refetch of the view (`If-None-Match`). Polling every
/// 60 seconds covers a stream that cannot connect, and a slower poll covers a missed event.
final class LiveDay: ObservableObject {
    @Published private(set) var cached: CachedView?
    @Published private(set) var outbox: CommandOutbox
    @Published private(set) var refreshing = false
    /// The last refresh got no answer or a failure; the view on screen is the last good one.
    @Published private(set) var refreshFailed = false
    @Published private(set) var failureNote: String?
    @Published private(set) var mode: LiveMode = .stopped
    /// The last time the server answered us or told us something changed.
    @Published private(set) var lastHeard: Date?
    /// Check-ins answered on this phone: not asked again while the next refresh catches up.
    @Published private(set) var answeredCheckIns = Set<String>()

    private let session: AppSession
    private let cacheFile: PrivateJSONFile<CachedView>
    private let outboxFile: PrivateJSONFile<CommandOutbox>
    private var subscription: AnyCancellable?
    private var liveTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var refreshAgain = false
    private var draining = false
    private var shownReported = Set<String>()

    init(session: AppSession, directory: URL) {
        self.session = session
        self.cacheFile = PrivateJSONFile<CachedView>(directory: directory, name: "client-view.json")
        self.outboxFile = PrivateJSONFile<CommandOutbox>(directory: directory, name: "command-outbox.json")
        self.cached = session.auth.session == nil ? nil : cacheFile.load()
        self.outbox = session.auth.session == nil ? CommandOutbox() : (outboxFile.load() ?? CommandOutbox())
        // A sign-out, or a phone paired again, ends everything that belonged to the old session.
        subscription = session.$auth.map { $0.session?.token }.removeDuplicates().dropFirst().sink { [weak self] _ in
            Task { @MainActor [weak self] in self?.sessionChanged() }
        }
        if session.auth.session == nil {
            cacheFile.delete()
            outboxFile.delete()
        }
    }

    private var signedIn: Bool { session.auth.session != nil }

    @MainActor
    private func sessionChanged() {
        stop()
        cached = nil
        outbox = CommandOutbox()
        refreshFailed = false
        failureNote = nil
        lastHeard = nil
        shownReported = []
        answeredCheckIns = []
        cacheFile.delete()
        outboxFile.delete()
        if signedIn { start() }
    }

    // MARK: Foreground and background

    /// Called when the app becomes active: refresh now, keep the stream and the safety poll running.
    @MainActor
    func start() {
        guard signedIn else { return }
        stop()
        mode = .polling
        liveTask = Task { @MainActor [weak self] in await self?.streamLoop() }
        pollTask = Task { @MainActor [weak self] in await self?.pollLoop() }
        Task { @MainActor in
            await self.refresh()
            await self.drainQueue()
        }
    }

    /// Called when the app leaves the foreground.
    @MainActor
    func stop() {
        liveTask?.cancel(); liveTask = nil
        pollTask?.cancel(); pollTask = nil
        retryTask?.cancel(); retryTask = nil
        mode = .stopped
    }

    @MainActor
    private func pollLoop() async {
        while !Task.isCancelled {
            let wait = mode == .stream ? RefreshPolicy.streamSafetyInterval : RefreshPolicy.pollInterval
            do { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) } catch { return }
            if Task.isCancelled { return }
            await refresh()
            await drainQueue()
        }
    }

    // MARK: Event stream

    @MainActor
    private func streamLoop() async {
        var attempt = 0
        while !Task.isCancelled {
            guard let device = session.auth.session else { return }
            let connected = await listen(device)
            if Task.isCancelled { return }
            if mode == .stream { mode = .polling }
            attempt = connected ? 1 : attempt + 1
            do { try await Task.sleep(nanoseconds: UInt64(RefreshPolicy.reconnectDelay(attempt: attempt) * 1_000_000_000)) } catch { return }
        }
    }

    /// Holds one stream connection open. True when it connected (and so ended later), false when it never did.
    @MainActor
    private func listen(_ device: DeviceSession) async -> Bool {
        guard let request = ClientRequests.events(origin: device.origin, token: device.token) else { return false }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 90
        configuration.timeoutIntervalForResource = 6 * 3600
        let urlSession = URLSession(configuration: configuration)
        defer { urlSession.invalidateAndCancel() }
        do {
            let (bytes, response) = try await urlSession.bytes(for: request, delegate: RefuseRedirects())
            guard let http = response as? HTTPURLResponse else { return false }
            if http.statusCode == 401 {
                handleRevoked(device)
                return false
            }
            guard http.statusCode == 200 else { return false }
            mode = .stream
            var splitter = LineSplitter()
            var parser = EventStreamParser()
            for try await byte in bytes {
                if Task.isCancelled { return true }
                guard let line = splitter.feed(byte), let event = parser.feed(line: line) else { continue }
                if event.name == "hello" || event.name == "changed" {
                    lastHeard = Date()
                    Task { @MainActor in
                        await self.refresh()
                        await self.drainQueue()
                    }
                }
            }
            return true
        } catch {
            return mode == .stream
        }
    }

    // MARK: Refresh

    /// Fetches the view (conditionally) and keeps the result. Also what pull-to-refresh runs.
    @MainActor
    func refresh() async {
        guard let device = session.auth.session else { return }
        if refreshing { refreshAgain = true; return }
        refreshing = true
        defer { refreshing = false }
        repeat {
            refreshAgain = false
            guard let request = ClientRequests.view(origin: device.origin, token: device.token, etag: cached?.etag) else {
                failureNote = ApiError.badResponse.message
                refreshFailed = true
                return
            }
            let answer = await session.api.send(request)
            guard session.auth.session?.token == device.token else { return }
            switch ViewFetch.interpret(answer, previous: cached, now: Date()) {
            case .updated(let next), .unchanged(let next):
                cached = next
                cacheFile.save(next)
                refreshFailed = false
                failureNote = nil
                lastHeard = Date()
            case .unreachable:
                refreshFailed = true
                failureNote = ApiError.unreachable.message
            case .revoked:
                handleRevoked(device)
                return
            case .failed(let words):
                refreshFailed = true
                failureNote = words
            }
        } while refreshAgain
    }

    @MainActor
    private func handleRevoked(_ device: DeviceSession) {
        session.tokenRejected(device.token)
    }

    // MARK: Check-ins

    /// Reports that the check-in sheet is open, once per check-in. The server stamps the time it was first shown.
    @MainActor
    func reportShown(checkInId: String) {
        guard let device = session.auth.session, !shownReported.contains(checkInId),
              let request = ClientRequests.shown(origin: device.origin, token: device.token, checkInId: checkInId) else { return }
        shownReported.insert(checkInId)
        Task { @MainActor in
            let answer = await session.api.send(request)
            guard session.auth.session?.token == device.token else { return }
            if let answer, answer.status == 401 { handleRevoked(device); return }
            // Not reached or refused: report again the next time the sheet opens.
            if answer == nil || !(200..<300).contains(answer?.status ?? 0) { shownReported.remove(checkInId) }
        }
    }

    /// Whether the view on screen is current enough to name its check-in's version.
    @MainActor
    private var viewIsCurrent: Bool {
        guard let cached else { return false }
        return !refreshFailed && !ViewFreshness.assess(cached, now: Date(), lastRefreshFailed: false).isStale
    }

    @MainActor
    func answer(_ checkIn: ClientCheckIn, choice: CheckInChoice, words: String?) {
        let command = CommandBuilders.answerCheckIn(checkInId: checkIn.id, title: checkIn.directiveTitle, choice: choice, words: words,
                                                    expectedVersion: viewIsCurrent ? checkIn.version : nil, at: Date())
        answeredCheckIns.insert(checkIn.id)
        enqueue(command)
    }

    // MARK: Sessions

    @MainActor
    func perform(_ action: SessionAction, controls: SessionControls, remaining: StopForNowFlow.SessionRemaining? = nil) {
        let now = Date()
        switch action {
        case .start(let actionId, let title, let minutes):
            enqueue(CommandBuilders.startSession(actionId: actionId, title: title, minutes: minutes, at: now))
        case .pause, .resume, .done, .stopForNow:
            guard let target = controls.target, let status = controls.status else { return }
            let verb: CommandBuilders.SessionVerb
            switch action {
            case .pause: verb = .pause
            case .resume: verb = .resume
            case .done: verb = .done
            default:
                guard let remaining else { return }
                switch remaining {
                case .minutes(let minutes, let words): verb = .stopWithRemaining(minutes: minutes, words: words)
                case .unsure(let words): verb = .stopUnsure(words: words)
                }
            }
            enqueue(CommandBuilders.sessionCommand(verb, target: target, title: controls.title, seenStatus: status, at: now))
        }
    }

    // MARK: Outbox

    @MainActor
    private func enqueue(_ command: OutboxCommand) {
        outbox.enqueue(command)
        outboxFile.save(outbox)
        Task { @MainActor in await self.drainQueue() }
    }

    @MainActor
    func retryHeld(_ commandId: String) {
        outbox.retryHeld(commandId: commandId)
        outboxFile.save(outbox)
        Task { @MainActor in await self.drainQueue() }
    }

    @MainActor
    func drop(_ commandId: String) {
        outbox.drop(commandId: commandId, now: Date())
        outboxFile.save(outbox)
    }

    @MainActor
    func dismissOutcome(_ id: String) {
        outbox.dismissOutcome(id: id)
        outboxFile.save(outbox)
    }

    /// Sends what is queued, one at a time, in the order it was made.
    @MainActor
    func drainQueue() async {
        guard !draining, let device = session.auth.session else { return }
        draining = true
        retryTask?.cancel()
        var background = UIBackgroundTaskIdentifier.invalid
        background = UIApplication.shared.beginBackgroundTask { UIApplication.shared.endBackgroundTask(background) }
        defer {
            draining = false
            if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
        }
        var sentAny = false
        loop: while true {
            guard session.auth.session?.token == device.token else { return }
            switch outbox.next(now: Date()) {
            case .nothing:
                break loop
            case .wait(let until):
                scheduleDrain(at: until)
                break loop
            case .send(var command):
                if command.needsVersionLookup {
                    let lookup = await lookUpVersion(for: command, device: device)
                    guard session.auth.session?.token == device.token else { return }
                    switch lookup {
                    case .signedOut:
                        handleRevoked(device)
                        return
                    case .retry:
                        _ = outbox.apply(.retry(afterSeconds: nil), to: command.commandId, now: Date())
                        outboxFile.save(outbox)
                        if case .wait(let until) = outbox.next(now: Date()) { scheduleDrain(at: until) }
                        break loop
                    case .held(let sentence):
                        _ = outbox.apply(.held(message: sentence), to: command.commandId, now: Date())
                        outboxFile.save(outbox)
                        continue loop
                    case .resolved(let version, let sessionId):
                        outbox.fill(commandId: command.commandId, expectedVersion: version, sessionId: sessionId)
                        guard let updated = outbox.items.first(where: { $0.commandId == command.commandId }) else { continue loop }
                        command = updated
                    }
                }
                guard let request = CommandRequests.request(command, origin: device.origin, token: device.token) else {
                    _ = outbox.apply(.held(message: "This command could not be built for your server's address."), to: command.commandId, now: Date())
                    outboxFile.save(outbox)
                    continue loop
                }
                let answer = await session.api.send(request)
                guard session.auth.session?.token == device.token else { return }
                let result = CommandResults.interpret(answer)
                if case .applied = result { sentAny = true }
                let step = outbox.apply(result, to: command.commandId, now: Date())
                outboxFile.save(outbox)
                switch step {
                case .continueDraining:
                    continue loop
                case .stop:
                    if case .wait(let until) = outbox.next(now: Date()) { scheduleDrain(at: until) }
                    break loop
                case .signedOut:
                    handleRevoked(device)
                    return
                }
            }
        }
        if sentAny { await refresh() }
    }

    private enum Lookup {
        case resolved(version: Int, sessionId: String?)
        case held(String)
        case retry
        case signedOut
    }

    /// Reads the client view afresh (no cached tag) for the version a session or start command must name:
    /// `pending.session.version`, or `now.directive.expectedVersion`. A session that has changed since the person
    /// tapped is reported in words, never overwritten.
    @MainActor
    private func lookUpVersion(for command: OutboxCommand, device: DeviceSession) async -> Lookup {
        guard let request = ClientRequests.view(origin: device.origin, token: device.token, etag: nil) else {
            return .held("This command could not be built for your server's address.")
        }
        let answer = await session.api.send(request)
        switch ViewFetch.interpret(answer, previous: nil, now: Date()) {
        case .unreachable: return .retry
        case .revoked: return .signedOut
        case .unchanged: return .retry
        case .failed(let message):
            if let status = answer?.status, status >= 500 || status == 429 || status == 408 { return .retry }
            return .held(message)
        case .updated(let cached):
            switch VersionResolution.resolve(command, view: cached.view) {
            case .send(let version, let sessionId): return .resolved(version: version, sessionId: sessionId)
            case .conflict(let sentence): return .held(sentence)
            }
        }
    }

    @MainActor
    private func scheduleDrain(at date: Date) {
        retryTask?.cancel()
        let delay = max(date.timeIntervalSinceNow, 1)
        retryTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
            await self?.drainQueue()
        }
    }
}
