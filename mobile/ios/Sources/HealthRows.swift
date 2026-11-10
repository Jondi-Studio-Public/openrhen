import Foundation

// Turns what the Health app holds into physiology rows, as the server's rules (platform/contracts/src/activity-physiology.ts,
// docs/operations/posting-physiology-data.md) demand them. Foundation only; HealthReader.swift does the HealthKit reading.

/// One hour of a total (steps), starting on a UTC hour.
struct HourlyValue: Equatable {
    let hourStart: Date
    let value: Double
}

/// One reading at an instant (a heart rate in beats a minute, a heart-rate variability in milliseconds).
struct Reading: Equatable {
    let at: Date
    let value: Double
}

enum SleepStage: String, Codable, Equatable {
    case inBed = "in_bed"
    case asleep
    case awake
    case light
    case deep
    case rem
}

/// A stretch of sleep data as Health holds it. `raw` is Health's own name for the stage (kept as `stage_raw`).
struct SleepPiece: Equatable {
    let start: Date
    let end: Date
    let stage: SleepStage
    let raw: String?
}

/// A row before it has a version: its identity (`kind` and `period`), when it starts, and its attrs without the
/// ones every row shares (`device`, `route`, `v`, `collector_version`), which `SensorState.plan` adds.
struct PlannedRow: Equatable {
    let kind: String
    /// The key's period part: the UTC hour start (`2026-11-08T10:00:00.000Z`) or, for sleep, the local date of waking.
    let period: String
    let start: Date
    let end: Date?
    let tzOffsetMin: Int?
    let attrs: [String: SensorValue]
}

enum HealthRows {
    static let hour: TimeInterval = 3600
    /// How long after an hour ends before its row is built, so a Watch that syncs a little late is mostly in it. A later
    /// change is still posted, as the next version.
    static let settleTime: TimeInterval = 30 * 60
    static let maxSamplesPerHour = 240
    /// A night is at least this long, so a nap is not one. Two stretches of sleep closer than `nightGap` are one night.
    static let minNight: TimeInterval = 3 * 3600
    static let nightGap: TimeInterval = 2 * 3600
    static let maxSegments = 200
    static let maxSleepSeconds: TimeInterval = 86_400

    static func hourStart(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / hour).rounded(.down) * hour)
    }

    static func slotText(_ hourStart: Date) -> String { ApiDates.string(hourStart) }

    /// `YYYY-MM-DD` of `instant` in a zone `offsetMin` minutes east of UTC.
    static func localDate(_ instant: Date, offsetMin: Int) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? TimeZone.current
        let parts = calendar.dateComponents([.year, .month, .day], from: instant.addingTimeInterval(TimeInterval(offsetMin * 60)))
        func pad(_ value: Int, _ width: Int) -> String {
            let text = String(value)
            return String(repeating: "0", count: max(width - text.count, 0)) + text
        }
        return "\(pad(parts.year ?? 1970, 4))-\(pad(parts.month ?? 1, 2))-\(pad(parts.day ?? 1, 2))"
    }

    private static func ended(_ start: Date, by now: Date) -> Bool {
        start.addingTimeInterval(hour + settleTime) <= now
    }

    // MARK: Steps

    /// One `steps` row per UTC hour that has ended and holds at least one step (an empty period is never posted).
    static func steps(_ hours: [HourlyValue], now: Date, offset: (Date) -> Int) -> [PlannedRow] {
        var byHour: [Date: Int] = [:]
        for entry in hours {
            let start = hourStart(entry.hourStart)
            guard ended(start, by: now), entry.value.isFinite else { continue }
            let count = Int(entry.value.rounded())
            guard count > 0, count <= 1_000_000 else { continue }
            byHour[start] = (byHour[start] ?? 0) + count
        }
        return byHour.keys.sorted().compactMap { start in
            guard let count = byHour[start], count <= 1_000_000 else { return nil }
            return PlannedRow(kind: "steps", period: slotText(start), start: start, end: nil, tzOffsetMin: offset(start),
                              attrs: ["steps": .int(count)])
        }
    }

    // MARK: Heart rate and heart-rate variability

    /// One irregular-sample row per UTC hour that has ended: `step_s` null with `t`, the second offsets of the readings.
    /// A reading outside what the kind can hold (a heart rate under 20 or over 260 beats a minute, a variability over 500 ms)
    /// is left out, not sent as it is. At most 240 readings go in a row; more are thinned evenly.
    static func heartRate(_ readings: [Reading], now: Date, offset: (Date) -> Int) -> [PlannedRow] {
        sampled(kind: "heart_rate", unit: "bpm", method: nil, readings: readings, now: now, offset: offset)
    }

    /// Health holds SDNN, so the method is `sdnn`.
    static func heartRateVariability(_ readings: [Reading], now: Date, offset: (Date) -> Int) -> [PlannedRow] {
        sampled(kind: "hrv", unit: "ms", method: "sdnn", readings: readings, now: now, offset: offset)
    }

    private static func sampled(kind: String, unit: String, method: String?, readings: [Reading], now: Date,
                                offset: (Date) -> Int) -> [PlannedRow] {
        let wholeNumbers = unit == "bpm"
        var byHour: [Date: [Reading]] = [:]
        for reading in readings.sorted(by: { $0.at < $1.at }) {
            guard reading.value.isFinite else { continue }
            let start = hourStart(reading.at)
            guard ended(start, by: now) else { continue }
            let value = wholeNumbers ? reading.value.rounded() : (reading.value * 10).rounded() / 10
            if wholeNumbers ? (value < 20 || value > 260) : (value < 0 || value > 500) { continue }
            byHour[start, default: []].append(Reading(at: reading.at, value: value))
        }
        var rows: [PlannedRow] = []
        for start in byHour.keys.sorted() {
            // One reading per second, in order: the server wants sorted, distinct offsets inside the hour.
            var offsets: [Int] = []
            var values: [Double] = []
            for reading in byHour[start] ?? [] {
                let second = min(max(Int(reading.at.timeIntervalSince(start)), 0), 3599)
                if let last = offsets.last, second <= last { continue }
                offsets.append(second)
                values.append(reading.value)
            }
            if offsets.count > maxSamplesPerHour {
                let stride = (offsets.count + maxSamplesPerHour - 1) / maxSamplesPerHour
                let keep = Swift.stride(from: 0, to: offsets.count, by: stride).map { $0 }
                offsets = keep.map { offsets[$0] }
                values = keep.map { values[$0] }
            }
            guard let low = values.min(), let high = values.max() else { continue }
            let mean = values.reduce(0, +) / Double(values.count)
            let average = (mean * 100).rounded() / 100
            // The seconds the readings cover: 15-second slots that hold one, as the finest step a heart_rate row allows.
            let coverage = min(Set(offsets.map { $0 / 15 }).count * 15, 3600)
            func number(_ value: Double) -> SensorValue { wholeNumbers ? .int(Int(value)) : .double(value) }
            var attrs: [String: SensorValue] = [
                "unit": .string(unit), "step_s": .null, "t": .array(offsets.map { .int($0) }),
                "values": .array(values.map { number($0) }), "n": .int(values.count),
                "min": number(low), "max": number(high), "avg": .double(average), "coverage_s": .int(coverage),
            ]
            if let method { attrs["method"] = .string(method) }
            rows.append(PlannedRow(kind: kind, period: slotText(start), start: start, end: nil, tzOffsetMin: offset(start), attrs: attrs))
        }
        return rows
    }

    // MARK: Sleep

    /// Which stage wins where pieces overlap (two sources, or "in bed" over the stages): the most specific first.
    private static func rank(_ stage: SleepStage) -> Int {
        switch stage {
        case .deep: return 0
        case .rem: return 1
        case .light: return 2
        case .awake: return 3
        case .asleep: return 4
        case .inBed: return 5
        }
    }

    struct Segment: Equatable {
        let start: Date
        let end: Date
        let stage: SleepStage
        let raw: String?
    }

    /// Pieces made into one run of non-overlapping segments in time order. Where pieces overlap the more specific stage
    /// wins; where none covers, there is a gap.
    static func flatten(_ pieces: [SleepPiece]) -> [Segment] {
        let whole = pieces.compactMap { piece -> SleepPiece? in
            let start = piece.start.timeIntervalSince1970.rounded()
            let end = piece.end.timeIntervalSince1970.rounded()
            guard end > start else { return nil }
            return SleepPiece(start: Date(timeIntervalSince1970: start), end: Date(timeIntervalSince1970: end), stage: piece.stage, raw: piece.raw)
        }
        var edges = Set<TimeInterval>()
        for piece in whole {
            edges.insert(piece.start.timeIntervalSince1970)
            edges.insert(piece.end.timeIntervalSince1970)
        }
        let ordered = edges.sorted()
        var segments: [Segment] = []
        var index = 0
        while index + 1 < ordered.count {
            let from = ordered[index]
            let to = ordered[index + 1]
            index += 1
            var best: SleepPiece?
            for piece in whole where piece.start.timeIntervalSince1970 <= from && piece.end.timeIntervalSince1970 >= to {
                if let current = best, rank(current.stage) <= rank(piece.stage) { continue }
                best = piece
            }
            guard let chosen = best else { continue }
            if let last = segments.last, last.end.timeIntervalSince1970 == from, last.stage == chosen.stage, last.raw == chosen.raw {
                segments[segments.count - 1] = Segment(start: last.start, end: Date(timeIntervalSince1970: to), stage: last.stage, raw: last.raw)
            } else {
                segments.append(Segment(start: Date(timeIntervalSince1970: from), end: Date(timeIntervalSince1970: to), stage: chosen.stage, raw: chosen.raw))
            }
        }
        return segments
    }

    /// One `sleep` row per night that has ended. Pieces within `nightGap` of each other are one night; one shorter than
    /// `minNight` (a nap) is left out; two nights that wake on the same local date keep the longer, because the key is that date.
    static func sleep(_ pieces: [SleepPiece], now: Date, offset: (Date) -> Int) -> [PlannedRow] {
        let sorted = pieces.filter { $0.end > $0.start }.sorted { $0.start < $1.start }
        var nights: [[SleepPiece]] = []
        var nightEnd = Date.distantPast
        for piece in sorted {
            if var current = nights.last, piece.start.timeIntervalSince(nightEnd) <= nightGap {
                current.append(piece)
                nights[nights.count - 1] = current
                nightEnd = max(nightEnd, piece.end)
            } else {
                nights.append([piece])
                nightEnd = piece.end
            }
        }
        var byDate: [String: (row: PlannedRow, span: TimeInterval)] = [:]
        for night in nights {
            guard let wake = night.map({ $0.end }).max(), wake.addingTimeInterval(settleTime) <= now else { continue }
            let segments = trimmed(flatten(night))
            guard let first = segments.first, let last = segments.last else { continue }
            let span = last.end.timeIntervalSince(first.start)
            guard span >= minNight, span <= maxSleepSeconds else { continue }
            let zone = offset(last.end)
            let date = localDate(last.end, offsetMin: zone)
            let items: [SensorValue] = segments.map { segment in
                var item: [String: SensorValue] = [
                    "start_s": .int(Int(segment.start.timeIntervalSince(first.start))),
                    "end_s": .int(Int(segment.end.timeIntervalSince(first.start))),
                    "stage": .string(segment.stage.rawValue),
                ]
                if let raw = segment.raw, !raw.isEmpty, raw.count <= 32 { item["stage_raw"] = .string(raw) }
                return .object(item)
            }
            let row = PlannedRow(kind: "sleep", period: date, start: first.start, end: last.end, tzOffsetMin: zone,
                                 attrs: ["local_date": .string(date), "segments": .array(items)])
            if let held = byDate[date], held.span >= span { continue }
            byDate[date] = (row, span)
        }
        return byDate.keys.sorted().compactMap { byDate[$0]?.row }
    }

    /// At most `maxSegments`: the shortest stretches are dropped (they become gaps), the rest kept in time order.
    private static func trimmed(_ segments: [Segment]) -> [Segment] {
        guard segments.count > maxSegments else { return segments }
        let longest = segments.enumerated().sorted { left, right in
            let a = left.element.end.timeIntervalSince(left.element.start)
            let b = right.element.end.timeIntervalSince(right.element.start)
            return a != b ? a > b : left.offset < right.offset
        }
        return longest.prefix(maxSegments).sorted { $0.offset < $1.offset }.map { $0.element }
    }
}

/// How far back each Health read goes. The numbers are in one place so they can be changed together.
enum HealthSyncPlan {
    /// The first read: a month of history, not the whole store.
    static let firstLookback: TimeInterval = 30 * 86_400
    /// Each later read starts this far before the last good one, so a late Watch sync lands in rows already posted.
    static let rereadWindow: TimeInterval = 2 * 86_400
    /// The server takes live rows up to 400 days old.
    static let maxLookback: TimeInterval = 390 * 86_400
    /// Sleep is read this much earlier, so a night that began before the window is whole.
    static let sleepExtra: TimeInterval = 18 * 3600

    struct Window: Equatable {
        let from: Date
        let sleepFrom: Date
        let to: Date
    }

    static func window(lastGoodRead: Date?, now: Date) -> Window {
        let raw = lastGoodRead.map { max($0.addingTimeInterval(-rereadWindow), now.addingTimeInterval(-maxLookback)) }
            ?? now.addingTimeInterval(-firstLookback)
        let from = HealthRows.hourStart(raw)
        return Window(from: from, sleepFrom: from.addingTimeInterval(-sleepExtra), to: now)
    }
}
