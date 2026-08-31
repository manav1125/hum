import XCTest
@testable import HaloKit

/// The client, against a stubbed transport.
///
/// What matters here is not that JSON decodes — it is that every failure
/// becomes a card the design already draws, and that the client never decides
/// something the daemon is supposed to decide.
final class HaloClientTests: XCTestCase {
    private var client: HaloClient!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        client = HaloClient(
            baseURL: URL(string: "https://manav.justcue.app")!,
            token: "t",
            session: URLSession(configuration: config)
        )
        StubProtocol.reset()
    }

    func testItBuildsTheV1PathAndCarriesTheToken() async throws {
        StubProtocol.stub(status: 200, json: #"{"sync":{"state":"up_to_date","behindSeconds":10,"snippet":null},"coveredThrough":1,"ledger":{"proposed":0,"accepted":0,"dismissed":0}}"#)
        _ = try await client.status()

        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/v1/halo/status")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer t")
    }

    func testUnreachableIsTheSameConditionAsOutOfRange() async {
        // Not an alert. The card already knows how to say "still recording".
        StubProtocol.stubFailure()
        do {
            _ = try await client.today()
            XCTFail("expected offline")
        } catch let error as HaloClient.HaloClientError {
            XCTAssertEqual(error, .offline)
            XCTAssertEqual(error.cardState, .outOfRange)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testAServerFailureNeverImpliesLostAudio() async {
        StubProtocol.stub(status: 503, json: "{}")
        do {
            _ = try await client.today()
            XCTFail("expected failure")
        } catch let error as HaloClient.HaloClientError {
            XCTAssertEqual(error.cardState, .understandingUnavailable)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testAnExpiredTokenAsksToSetUpRatherThanShowingAnError() async {
        StubProtocol.stub(status: 401, json: "{}")
        do {
            _ = try await client.status()
            XCTFail("expected unauthorized")
        } catch let error as HaloClient.HaloClientError {
            XCTAssertEqual(error.cardState, .neverPaired)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testTheDaemonDecidesWhetherSomethingDocks() async throws {
        // The client must not infer this from the verb: only the server knows
        // whether a work item was really created.
        StubProtocol.stub(status: 200, json: #"{"status":"accepted","workItemId":"w1","presentation":"composer"}"#)
        let composer = try await client.accept(proposalId: "p")
        XCTAssertEqual(composer.outcome, .opensComposer(workItemId: "w1"))
        XCTAssertFalse(composer.outcome.docksNow)

        StubProtocol.stub(status: 200, json: #"{"status":"accepted","workItemId":"w2","presentation":"dock"}"#)
        let docked = try await client.accept(proposalId: "p")
        XCTAssertTrue(docked.outcome.docksNow)
    }

    func testAnAcceptThatDidNotSucceedNeverDocks() async throws {
        // The dock is a factual claim; a response without a work item is not
        // one, whatever it says.
        StubProtocol.stub(status: 200, json: #"{"status":"already_decided","workItemId":null,"presentation":null}"#)
        let response = try await client.accept(proposalId: "p")
        XCTAssertFalse(response.outcome.docksNow)
        XCTAssertNil(response.outcome.undoMessage)
    }

    func testAMarkIsSentInEpochMilliseconds() async throws {
        StubProtocol.stub(status: 200, json: #"{"id":"m","kind":"bookmark","markedAt":1788000000000}"#)
        let when = Date(timeIntervalSince1970: 1_788_000_000)
        _ = try await client.mark(at: when, words: "the Vercel bill")

        let body = try XCTUnwrap(StubProtocol.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["markedAt"] as? Int, 1_788_000_000_000)
        XCTAssertEqual(json["words"] as? String, "the Vercel bill")
    }
}

/// A URLProtocol that answers from a stub, so no test touches the network.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var stubbedStatus = 200
    nonisolated(unsafe) static var stubbedJSON = "{}"
    nonisolated(unsafe) static var shouldFail = false
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?

    static func reset() {
        stubbedStatus = 200
        stubbedJSON = "{}"
        shouldFail = false
        lastRequest = nil
        lastBody = nil
    }

    static func stub(status: Int, json: String) {
        shouldFail = false
        stubbedStatus = status
        stubbedJSON = json
    }

    static func stubFailure() { shouldFail = true }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        // URLProtocol strips httpBody into a stream; read it back for asserts.
        Self.lastBody = request.httpBody ?? request.httpBodyStream.map { stream in
            stream.open()
            defer { stream.close() }
            var data = Data()
            let size = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: size)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            return data
        }

        if Self.shouldFail {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.stubbedStatus,
            httpVersion: nil, headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.stubbedJSON.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
