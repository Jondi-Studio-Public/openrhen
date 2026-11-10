import Foundation

/// One Codable value kept as a JSON file in Application Support: complete-until-first-user-authentication file
/// protection, and kept out of device backups. An unreadable or missing file reads as nothing. Foundation only.
final class PrivateJSONFile<Value: Codable> {
    let directory: URL
    let fileURL: URL

    init(directory: URL, name: String) {
        self.directory = directory
        self.fileURL = directory.appendingPathComponent(name)
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }

    func load() -> Value? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? PrivateJSONFile<Value>.decoder().decode(Value.self, from: data)
    }

    @discardableResult
    func save(_ value: Value) -> Bool {
        guard prepareDirectory(), let data = try? PrivateJSONFile<Value>.encoder().encode(value) else { return false }
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        return (try? data.write(to: fileURL, options: options)) != nil
    }

    func delete() { try? FileManager.default.removeItem(at: fileURL) }

    private func prepareDirectory() -> Bool {
        let manager = FileManager.default
        if !manager.fileExists(atPath: directory.path) {
            do {
                var attributes: [FileAttributeKey: Any] = [:]
                #if os(iOS)
                attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
                #endif
                try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
            } catch {
                return false
            }
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = directory
        try? target.setResourceValues(values)
        return true
    }
}
