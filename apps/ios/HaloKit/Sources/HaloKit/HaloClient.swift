import Foundation

/// The daemon, as the surfaces need it.
///
/// One place that knows the routes, so a view never builds a URL. Thin on
/// purpose: `/v1/halo/*` already returns the shapes the frames draw, and a
/// client that re-derived counts or re-decided the sync state would be a
/// second opinion about facts the daemon already settled.
///
/// ## Errors are states, not alerts
///
/// Every failure resolves to a `HaloCardState` the card already knows how to
/// draw. An always-on recorder that throws modal errors at somebody teaches
/// them the device is fragile; the design draws every problem as a card,
/// including the ones that are the network's fault.
public struct HaloClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSession

    /// `https://your-instance` — `/v1` is appended here so callers cannot
    /// disagree about whether it belongs in the base.
    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    public enum HaloClientError: Error, Equatable, Sendable {
        case unauthorized
        case notFound
        case offline
        case server(status: Int)
        case malformed

        /// How the surface should draw this. Never an alert.
        public var cardState: HaloCardState {
            switch self {
            case .unauthorized: return .neverPaired
            case .offline: return .outOfRange
            // Audio is safe; understanding is delayed. Never imply loss.
            case .notFound, .server, .malformed: return .understandingUnavailable
            }
        }
    }

    // MARK: - Reads

    public func status() async throws -> HaloStatus {
        try await get("halo/status")
    }

    public func today() async throws -> HaloDay {
        try await get("halo/today")
    }

    public func day(_ localDate: String) async throws -> HaloDay {
        try await get("halo/days/\(localDate)")
    }

    public func proposals(limit: Int = 50) async throws -> HaloQueue {
        try await get("halo/proposals?limit=\(limit)")
    }

    // MARK: - Writes

    /// The ✓. Returns what actually happened, so the dock only animates a
    /// real filing and a draft opens the composer instead.
    @discardableResult
    public func accept(proposalId: String) async throws -> AcceptResponse {
        try await post("halo/proposals/accept", body: ["proposalId": proposalId])
    }

    @discardableResult
    public func dismiss(proposalId: String) async throws -> AcceptResponse {
        try await post("halo/proposals/dismiss", body: ["proposalId": proposalId])
    }

    /// A ⚑ or ✦ from the device. Sent before the audio around it arrives —
    /// the button registering is the promise.
    @discardableResult
    public func mark(at markedAt: Date, kind: String = "bookmark", words: String? = nil) async throws -> MarkResponse {
        var body: [String: Any] = [
            "markedAt": Int(markedAt.timeIntervalSince1970 * 1000),
            "kind": kind
        ]
        if let words { body["words"] = words }
        return try await post("halo/marks", body: body)
    }

    // MARK: - Shapes

    public struct HaloStatus: Codable, Equatable, Sendable {
        public let sync: HaloSync
        public let coveredThrough: Int?
        public let ledger: HaloLedger
    }

    public struct HaloQueue: Codable, Equatable, Sendable {
        public let proposals: [HaloProposal]
        public let ledger: HaloLedger
    }

    public struct AcceptResponse: Codable, Equatable, Sendable {
        public let status: String
        public let workItemId: String?
        /// "dock" | "composer" — S6 ruling 3, decided by the daemon so the
        /// client cannot animate something the server did not do.
        public let presentation: String?

        public var outcome: HaloAcceptOutcome {
            guard status == "accepted", let workItemId else {
                return .failed(reason: status)
            }
            return presentation == "composer"
                ? .opensComposer(workItemId: workItemId)
                : .docked(destination: nil, workItemId: workItemId)
        }
    }

    public struct MarkResponse: Codable, Equatable, Sendable {
        public let id: String
        public let kind: String
        public let markedAt: Int
    }

    // MARK: - Transport

    private func request(_ path: String, method: String, body: [String: Any]?) throws -> URLRequest {
        guard let url = URL(string: "v1/\(path)", relativeTo: baseURL) else {
            throw HaloClientError.malformed
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            // Unreachable is not an error worth an alert — it is the same
            // condition as being out of range, and the card says so.
            throw HaloClientError.offline
        }

        guard let http = response as? HTTPURLResponse else {
            throw HaloClientError.malformed
        }
        switch http.statusCode {
        case 200..<300: break
        case 401, 403: throw HaloClientError.unauthorized
        case 404: throw HaloClientError.notFound
        default: throw HaloClientError.server(status: http.statusCode)
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw HaloClientError.malformed
        }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(request(path, method: "GET", body: nil))
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        try await send(request(path, method: "POST", body: body))
    }
}
