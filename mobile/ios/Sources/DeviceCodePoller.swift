import Foundation

/// One answer to a poll of `POST /api/owner/devices/code/token`, reduced to what the state machine needs.
enum DeviceCodeReply: Equatable {
    case approved
    case pending
    case slowDown
    case expired
    case denied
    /// No HTTP answer (offline) or a 5xx: worth trying again.
    case networkError
    case rateLimited(retryAfter: Int?)
    /// Anything else, with a short description (for example `invalid_request`).
    case unknown(String)
}

enum DeviceCodeFailure: Equatable {
    case expired
    case denied
    case unreachable
    case unexpected(String)

    var message: String {
        switch self {
        case .expired: return "The code expired. Start again to get a new one."
        case .denied: return "The code was denied on the portal. Start again if that was a mistake."
        case .unreachable: return "Can't reach your server. Check the phone is online, then start again."
        case .unexpected(let what): return "The server refused the code (\(what)). Start again."
        }
    }
}

/// The device-code poll loop of RFC 8628, without the clock or the network: feed it each reply, it says what
/// to do next. `slow_down` widens the wait by 5 seconds (capped at 60); `expired_token` and `access_denied`
/// end it; so does the local deadline; repeated network errors end it too.
struct DeviceCodePoller: Equatable {
    static let slowDownStep: TimeInterval = 5
    static let maxInterval: TimeInterval = 60
    static let minInterval: TimeInterval = 1
    static let defaultInterval: TimeInterval = 5
    static let maxConsecutiveNetworkErrors = 5

    enum Step: Equatable {
        /// Wait this many seconds, then poll again.
        case wait(TimeInterval)
        case approved
        case failed(DeviceCodeFailure)
    }

    private(set) var interval: TimeInterval
    let deadline: Date
    private(set) var networkErrors = 0

    /// `interval` and `expiresIn` are in seconds, as the server sent them.
    init(interval: Int, expiresIn: Int, now: Date) {
        let wanted = interval > 0 ? TimeInterval(interval) : DeviceCodePoller.defaultInterval
        self.interval = min(max(wanted, DeviceCodePoller.minInterval), DeviceCodePoller.maxInterval)
        self.deadline = now.addingTimeInterval(TimeInterval(max(expiresIn, 0)))
    }

    mutating func record(_ reply: DeviceCodeReply, now: Date) -> Step {
        if reply == .approved { return .approved }
        if now >= deadline { return .failed(.expired) }
        switch reply {
        case .approved:
            return .approved
        case .pending:
            networkErrors = 0
            return .wait(interval)
        case .slowDown:
            networkErrors = 0
            interval = min(interval + DeviceCodePoller.slowDownStep, DeviceCodePoller.maxInterval)
            return .wait(interval)
        case .expired:
            return .failed(.expired)
        case .denied:
            return .failed(.denied)
        case .networkError:
            networkErrors += 1
            if networkErrors >= DeviceCodePoller.maxConsecutiveNetworkErrors { return .failed(.unreachable) }
            return .wait(interval)
        case .rateLimited(let retryAfter):
            let wait = max(interval, TimeInterval(retryAfter ?? 0))
            return .wait(min(wait, DeviceCodePoller.maxInterval))
        case .unknown(let what):
            return .failed(.unexpected(what))
        }
    }
}
