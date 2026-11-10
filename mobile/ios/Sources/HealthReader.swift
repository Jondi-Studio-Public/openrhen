import Foundation
import HealthKit

/// Reads sleep, steps, heart rate and heart-rate variability from the Health app (read only: the app writes nothing
/// to Health). It hands back plain values; `HealthRows` turns them into the rows the server takes.
struct HealthRead {
    var steps: [HourlyValue] = []
    var heartRate: [Reading] = []
    var variability: [Reading] = []
    var sleep: [SleepPiece] = []
}

final class HealthReader {
    private let store = HKHealthStore()

    static var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    private var readTypes: Set<HKObjectType> {
        var types = Set<HKObjectType>()
        for identifier in [HKQuantityTypeIdentifier.stepCount, .heartRate, .heartRateVariabilitySDNN] {
            if let type = HKObjectType.quantityType(forIdentifier: identifier) { types.insert(type) }
        }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { types.insert(sleep) }
        return types
    }

    /// Asks iOS for permission to read. iOS shows its sheet once; later calls return at once. It never says whether
    /// reading was allowed, so a denial looks like an empty store.
    func requestAccess() async throws {
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    /// Asks iOS to wake the app when new data arrives, and calls `onNewData` whenever it does (and whenever new data
    /// arrives while the app is open). Returns the error iOS gave if it refused background delivery, which free signing
    /// may do; the observers still work while the app is running.
    func startObserving(onNewData: @escaping () -> Void) async -> Error? {
        var refused: Error?
        for type in readTypes {
            guard let sampleType = type as? HKSampleType else { continue }
            let query = HKObserverQuery(sampleType: sampleType, predicate: nil) { _, completion, error in
                if error == nil { onNewData() }
                completion()
            }
            store.execute(query)
            do {
                try await store.enableBackgroundDelivery(for: sampleType, frequency: .hourly)
            } catch {
                refused = error
            }
        }
        return refused
    }

    func read(window: HealthSyncPlan.Window) async throws -> HealthRead {
        var result = HealthRead()
        result.steps = try await hourlySteps(from: window.from, to: window.to)
        result.heartRate = try await readings(.heartRate, unit: HKUnit.count().unitDivided(by: .minute()), from: window.from, to: window.to)
        result.variability = try await readings(.heartRateVariabilitySDNN, unit: HKUnit.secondUnit(with: .milli), from: window.from, to: window.to)
        result.sleep = try await sleepPieces(from: window.sleepFrom, to: window.to)
        return result
    }

    /// Steps per UTC hour. Health's own statistics merge the phone and the Watch, so a step both counted is counted once.
    private func hourlySteps(from: Date, to: Date) async throws -> [HourlyValue] {
        guard let type = HKObjectType.quantityType(forIdentifier: .stepCount) else { return [] }
        return try await withCheckedThrowingContinuation { continuation in
            var interval = DateComponents()
            interval.hour = 1
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
            let query = HKStatisticsCollectionQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum,
                                                    anchorDate: Date(timeIntervalSince1970: 0), intervalComponents: interval)
            query.initialResultsHandler = { _, collection, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                var hours: [HourlyValue] = []
                collection?.enumerateStatistics(from: from, to: to) { statistics, _ in
                    if let sum = statistics.sumQuantity() {
                        hours.append(HourlyValue(hourStart: statistics.startDate, value: sum.doubleValue(for: HKUnit.count())))
                    }
                }
                continuation.resume(returning: hours)
            }
            store.execute(query)
        }
    }

    private func readings(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, from: Date, to: Date) async throws -> [Reading] {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return [] }
        return try await withCheckedThrowingContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, results, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let samples = (results as? [HKQuantitySample]) ?? []
                continuation.resume(returning: samples.map { Reading(at: $0.startDate, value: $0.quantity.doubleValue(for: unit)) })
            }
            store.execute(query)
        }
    }

    private func sleepPieces(from: Date, to: Date) async throws -> [SleepPiece] {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return [] }
        return try await withCheckedThrowingContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, results, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                var pieces: [SleepPiece] = []
                for sample in (results as? [HKCategorySample]) ?? [] {
                    guard let value = HKCategoryValueSleepAnalysis(rawValue: sample.value) else { continue }
                    let stage: SleepStage
                    let raw: String
                    switch value {
                    case .inBed: stage = .inBed; raw = "inBed"
                    case .asleepUnspecified: stage = .asleep; raw = "asleepUnspecified"
                    case .awake: stage = .awake; raw = "awake"
                    case .asleepCore: stage = .light; raw = "asleepCore"
                    case .asleepDeep: stage = .deep; raw = "asleepDeep"
                    case .asleepREM: stage = .rem; raw = "asleepREM"
                    default: continue
                    }
                    pieces.append(SleepPiece(start: sample.startDate, end: sample.endDate, stage: stage, raw: raw))
                }
                continuation.resume(returning: pieces)
            }
            store.execute(query)
        }
    }
}
