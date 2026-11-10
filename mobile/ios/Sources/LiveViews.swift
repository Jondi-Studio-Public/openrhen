import SwiftUI

extension ClientCheckIn: Identifiable {}

extension LiveDay {
    /// The waiting check-in, unless an answer to it is already queued here.
    var waitingCheckIn: ClientCheckIn? {
        guard let checkIn = cached?.view.pending?.checkIn, !outbox.hasQueuedAnswer(forCheckIn: checkIn.id),
              !answeredCheckIns.contains(checkIn.id) else { return nil }
        return checkIn
    }

    var planZone: TimeZone {
        cached.map { ViewPresentation.zone(of: $0.view) } ?? TimeZone.current
    }
}

/// The signed-in app: the native day screens and, beside them, the portal's own screens for planning.
struct LiveRootView: View {
    let device: DeviceSession
    let portalURL: URL
    @EnvironmentObject var live: LiveDay
    @State private var presenting: ClientCheckIn?
    @State private var declined = Set<String>()

    var body: some View {
        TabView {
            NowView(present: { presenting = $0 })
                .tabItem { Label("Now", systemImage: "clock") }
            DayView()
                .tabItem { Label("Day", systemImage: "calendar") }
            PortalWebView(url: portalURL, device: device)
                .id(device.token)
                .tabItem { Label("Plan", systemImage: "list.bullet.rectangle") }
            SourcesView()
                .tabItem { Label("Sources", systemImage: "antenna.radiowaves.left.and.right") }
        }
        .sheet(item: $presenting) { checkIn in
            CheckInSheet(checkIn: checkIn, onNotNow: { declined.insert(checkIn.id) })
        }
        .onChange(of: live.waitingCheckIn?.id) { id in
            // A new waiting check-in opens its sheet once; "Not now" is not asked again (the next slot asks).
            if let id, !declined.contains(id), presenting == nil, let waiting = live.waitingCheckIn { presenting = waiting }
        }
    }
}

// MARK: Shared pieces

/// "as of 09:05" and why the view may be old. Dims what follows through the caller.
struct FreshnessRow: View {
    let freshness: ViewFreshness

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(freshness.asOfText).font(.footnote).foregroundStyle(.secondary)
            if let reason = freshness.reason {
                Text(reason).font(.footnote).foregroundStyle(freshness.isStale ? Color.orange : Color.secondary)
            }
        }
    }
}

/// What the server said about a command in words, with the choices a held one leaves.
struct OutcomeRow: View {
    let outcome: CommandOutcome
    @EnvironmentObject var live: LiveDay

    private var heldCommand: OutboxCommand? {
        live.outbox.items.first { $0.commandId == outcome.id && $0.hold != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(outcome.label).font(.subheadline).bold()
            Text(outcome.message).font(.footnote)
            if heldCommand != nil {
                HStack {
                    Button("Try again") { live.retryHeld(outcome.id) }.buttonStyle(.bordered)
                    Button("Drop", role: .destructive) { live.drop(outcome.id) }.buttonStyle(.bordered)
                }
            } else {
                Button("Dismiss") { live.dismissOutcome(outcome.id) }.buttonStyle(.borderless).font(.footnote)
            }
        }
        .padding(.vertical, 2)
    }
}

extension CommandOutbox {
    /// Results the person should read: anything that was not a plain success.
    var outcomesToRead: [CommandOutcome] {
        outcomes.filter { $0.kind != .applied && $0.kind != .dropped }.reversed()
    }
}

// MARK: Now

struct NowView: View {
    let present: (ClientCheckIn) -> Void
    @EnvironmentObject var live: LiveDay
    @State private var stopping: SessionControls?

    var body: some View {
        NavigationView {
            TimelineView(.periodic(from: Date(), by: 30)) { context in
                List {
                    if let cached = live.cached {
                        loaded(cached, now: context.date)
                    } else {
                        Section {
                            Text(live.refreshing ? "Asking your server..." : (live.failureNote ?? "Nothing to show yet."))
                            Text("Pull down to try again.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(live.outbox.outcomesToRead) { outcome in
                        Section { OutcomeRow(outcome: outcome) }
                    }
                }
                .refreshable { await live.refresh() }
            }
            .navigationTitle("Now")
        }
        .navigationViewStyle(.stack)
        .sheet(item: $stopping) { controls in StopSheet(controls: controls) }
    }

    @ViewBuilder
    private func loaded(_ cached: CachedView, now: Date) -> some View {
        let freshness = ViewFreshness.assess(cached, now: now, lastRefreshFailed: live.refreshFailed)
        let model = ViewPresentation.now(cached.view, at: now, fetchedAt: cached.fetchedAt)
        let controls = SessionControls.make(view: cached.view, outbox: live.outbox)
        Section { FreshnessRow(freshness: freshness) }
        if let zoneNote = model.zoneNote {
            Section { Text(zoneNote).font(.footnote) }
        }
        if let checkIn = live.waitingCheckIn {
            Section(header: Text("Check-in")) {
                Text(ViewPresentation.checkInQuestion(checkIn)).font(.headline)
                Text(ViewPresentation.checkInNote(checkIn, zone: live.planZone)).font(.footnote).foregroundStyle(.secondary)
                Button("Answer") { present(checkIn) }.buttonStyle(.borderedProminent)
            }
        }
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(model.headline).font(.title2).bold()
                if let why = model.why { Text(why).foregroundStyle(.secondary) }
                if let line = model.timeLine { Text(line).font(.headline) }
            }
            .opacity(freshness.isStale ? 0.5 : 1)
            if let leave = model.leaveByLine { Text(leave).opacity(freshness.isStale ? 0.5 : 1) }
            ForEach(model.offers, id: \.self) { offer in Text(offer).font(.footnote) }
        }
        if let place = model.placeLine {
            Section(header: Text("Where you are")) {
                Text(place)
                Text("Confirm the place in the Plan tab.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        sessionSection(controls)
        if !model.questions.isEmpty {
            Section(header: Text("The plan would like to know")) {
                ForEach(model.questions, id: \.self) { question in Text(question) }
                Text("Answer these in the Plan tab.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func sessionSection(_ controls: SessionControls) -> some View {
        if !controls.actions.isEmpty || controls.blockedNote != nil || controls.pendingNote != nil {
            Section(header: Text("Session")) {
                if let blocked = controls.blockedNote {
                    Text("Waiting on you: \(blocked)").font(.footnote)
                    Text("Choose Try again or Drop under Sources.").font(.footnote).foregroundStyle(.secondary)
                }
                if !controls.actions.isEmpty {
                    HStack {
                        ForEach(controls.actions, id: \.self) { action in
                            Button(label(for: action)) { tapped(action, controls) }.buttonStyle(.bordered)
                        }
                    }
                }
                if let note = controls.pendingNote { Text(note).font(.footnote).foregroundStyle(.secondary) }
            }
        }
    }

    private func label(for action: SessionAction) -> String {
        switch action {
        case .start(_, _, let minutes): return "Start (\(TimeText.minutes(minutes)))"
        case .pause: return "Pause"
        case .resume: return "Resume"
        case .done: return "Done"
        case .stopForNow: return "Stop for now"
        }
    }

    private func tapped(_ action: SessionAction, _ controls: SessionControls) {
        if action == .stopForNow { stopping = controls } else { live.perform(action, controls: controls) }
    }
}

extension SessionControls: Identifiable {
    var id: String { "\(status ?? "none")-\(title)" }
}

/// "Stop for now": says in words how much is left; asks once more if the minutes can't be read.
struct StopSheet: View {
    let controls: SessionControls
    @EnvironmentObject var live: LiveDay
    @Environment(\.dismiss) private var dismiss
    @State private var flow = StopForNowFlow()
    @State private var text = ""

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text(controls.title)) {
                    Text(flow.prompt)
                    TextField("In your own words", text: $text)
                }
                Section {
                    Button("Send") { send() }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if flow.phase == .askingAgain {
                        Button("Send my words as they are") { apply(flow.sendWordsOnly()) }
                    }
                    Button("Cancel", role: .cancel) { dismiss() }
                }
            }
            .navigationTitle("Stop for now")
        }
    }

    private func send() {
        let outcome = flow.submit(text)
        text = ""
        apply(outcome)
    }

    private func apply(_ outcome: StopForNowFlow.Outcome) {
        switch outcome {
        case .askAgain:
            break
        case .send(let remaining):
            live.perform(.stopForNow, controls: controls, remaining: remaining)
            dismiss()
        }
    }
}

// MARK: Check-in

/// Yes / No, I'm doing... / Not sure, with his words on any answer. No preset list of reasons. The server is told the
/// sheet opened (`POST /api/check-ins/{id}/shown`) when it appears.
struct CheckInSheet: View {
    let checkIn: ClientCheckIn
    let onNotNow: () -> Void
    @EnvironmentObject var live: LiveDay
    @Environment(\.dismiss) private var dismiss
    @State private var words = ""

    private var cleaned: (words: String?, tooLong: Bool) { CommandBuilders.cleanWords(words) }

    var body: some View {
        NavigationView {
            Form {
                Section {
                    Text(ViewPresentation.checkInQuestion(checkIn)).font(.headline)
                    Text(ViewPresentation.checkInNote(checkIn, zone: live.planZone)).font(.footnote).foregroundStyle(.secondary)
                }
                Section(header: Text("What are you doing? In your own words (optional)")) {
                    TextEditor(text: $words).frame(minHeight: 100)
                    if cleaned.tooLong {
                        Text("That is over \(CommandBuilders.maxWords) characters; please shorten it.").font(.footnote).foregroundStyle(.red)
                    }
                }
                Section {
                    Button("Yes, on it") { answer(.yes) }
                    Button("No, I'm doing...") { answer(.no) }
                    Button("Not sure") { answer(.notSure) }
                }
                .disabled(cleaned.tooLong)
                Section {
                    Button("Not now", role: .cancel) { onNotNow(); dismiss() }
                }
            }
            .navigationTitle("Check-in")
            .onAppear { live.reportShown(checkInId: checkIn.id) }
        }
    }

    private func answer(_ choice: CheckInChoice) {
        live.answer(checkIn, choice: choice, words: cleaned.words)
        dismiss()
    }
}

// MARK: Day

struct DayView: View {
    @EnvironmentObject var live: LiveDay

    var body: some View {
        NavigationView {
            TimelineView(.periodic(from: Date(), by: 60)) { context in
                List {
                    if let cached = live.cached {
                        let freshness = ViewFreshness.assess(cached, now: context.date, lastRefreshFailed: live.refreshFailed)
                        let rows = ViewPresentation.day(cached.view, at: context.date)
                        Section {
                            FreshnessRow(freshness: freshness)
                            Text("Times are in \(cached.view.timezone).").font(.footnote).foregroundStyle(.secondary)
                        }
                        Section {
                            if rows.isEmpty { Text("Nothing else is planned for today.") }
                            ForEach(rows, id: \.id) { row in
                                dayRow(row).opacity(freshness.isStale ? 0.5 : 1)
                            }
                        }
                    } else {
                        Section { Text(live.failureNote ?? "Nothing to show yet.") }
                    }
                }
                .refreshable { await live.refresh() }
            }
            .navigationTitle("Day")
        }
        .navigationViewStyle(.stack)
    }

    private func dayRow(_ row: ViewPresentation.DayRow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(row.range).font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                if row.isNow { Text("now").font(.caption).bold().foregroundStyle(.tint) }
            }
            Text(row.title).font(row.isNow ? .headline : .body)
            Text(row.detail).font(.footnote).foregroundStyle(.secondary)
            if let changed = row.changedBy { Text(changed).font(.footnote) }
        }
    }
}

// MARK: Sources

struct SourcesView: View {
    @EnvironmentObject var session: AppSession
    @EnvironmentObject var live: LiveDay
    @EnvironmentObject var location: LocationReporter
    @EnvironmentObject var sensors: SensorCenter
    @State private var showingSettings = false

    var body: some View {
        NavigationView {
            TimelineView(.periodic(from: Date(), by: 30)) { context in
                List {
                    let queue = SourcesWords.queue(live.outbox, now: context.date)
                    Section(header: Text("Your server")) {
                        if let device = session.auth.session { Text(HostPolicy.displayName(ofOrigin: device.origin)) }
                        Text(SourcesWords.lastHeard(live.lastHeard, now: context.date, zone: live.planZone))
                        Text(SourcesWords.liveMode(live.mode)).font(.footnote).foregroundStyle(.secondary)
                        if live.refreshFailed, let note = live.failureNote { Text(note).font(.footnote).foregroundStyle(.orange) }
                    }
                    Section(header: Text("What this phone sends")) {
                        Text("Place changes: \(location.status)")
                        Text("Your check-in answers and session changes, with the time you did them.").font(.footnote)
                    }
                    SensorSections(now: context.date, zone: live.planZone)
                    Section(header: Text("What feeds the plan")) {
                        Text("Your server builds the plan from its own connections and from what this phone sends. The connections are shown on your server's pages in the Plan tab.")
                            .font(.footnote)
                        Text("Check-ins come to this phone only while the app is open; it does not wake itself to ask.").font(.footnote).foregroundStyle(.secondary)
                    }
                    Section(header: Text("Waiting to send")) {
                        Text(queue.headline)
                        if let warning = queue.warning { Text(warning).font(.footnote).foregroundStyle(.orange) }
                        ForEach(live.outbox.items) { command in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(command.label)
                                Text("Made at \(TimeText.clock(command.madeAt, in: live.planZone))").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if !live.outbox.outcomesToRead.isEmpty {
                        Section(header: Text("Needs a look")) {
                            ForEach(live.outbox.outcomesToRead) { outcome in OutcomeRow(outcome: outcome) }
                        }
                    }
                }
                .refreshable { await live.refresh(); await live.drainQueue(); await sensors.refresh() }
            }
            .navigationTitle("Sources")
            .toolbar {
                Button { showingSettings = true } label: { Image(systemName: "gearshape") }
            }
            .sheet(isPresented: $showingSettings) { SettingsView() }
        }
        .navigationViewStyle(.stack)
        .onChange(of: session.auth.session?.token) { _ in showingSettings = false }
    }
}
