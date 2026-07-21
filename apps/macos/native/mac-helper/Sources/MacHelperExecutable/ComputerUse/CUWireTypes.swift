// Vendored from clients/shared/Network/MessageTypes.swift for the mac-helper port.
// These are the daemon<->helper computer-use / app-control wire types. Kept
// as a self-contained file so the helper has no dependency on the retiring
// VellumAssistantShared module. 'public' modifiers are harmless in-target.

import Foundation
import CoreGraphics

public struct HostCuRequest: Decodable, Sendable {
    public let type: String
    public let requestId: String
    public let conversationId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let stepNumber: Int
    public let reasoning: String?
    /// When set, this request is targeted at a specific client ID. Non-nil only for
    /// cross-client proxy requests routed through HostCuProxy.
    public let targetClientId: String?

    private enum CodingKeys: String, CodingKey {
        case type
        case requestId
        case conversationId
        case toolName
        case input
        case stepNumber
        case reasoning
        case targetClientId
    }
}

/// Cancellation signal from the daemon telling the client to abort an in-flight
/// host computer-use action identified by `requestId`.
public struct HostCuCancelRequest: Decodable, Sendable {
    public let type: String
    public let requestId: String
}

// MARK: - Host App Control

/// Request from the daemon to execute an app-control action on the host.
/// Mirrors the TypeScript `HostAppControlRequest` shape: a wire message that
/// the desktop client receives via SSE, executes locally (start/observe/press/
/// type/click/drag/etc. against a target macOS app), and POSTs the result back.
public struct HostAppControlRequest: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let conversationId: String
    public let input: HostAppControlInput

    public init(
        type: String,
        requestId: String,
        conversationId: String,
        input: HostAppControlInput
    ) {
        self.type = type
        self.requestId = requestId
        self.conversationId = conversationId
        self.input = input
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case requestId
        case conversationId
        case input
    }
}

/// A single step inside `.sequence`: one key press with optional modifiers,
/// hold duration, and post-press gap. Mirrors the TypeScript
/// `HostAppControlSequenceStep` shape — snake_case wire keys mapped to Swift
/// camelCase via explicit raw values.
public struct HostAppControlSequenceStep: Codable, Equatable, Sendable {
    public let key: String
    public let modifiers: [String]?
    public let durationMs: Int?
    public let gapMs: Int?

    public init(
        key: String,
        modifiers: [String]? = nil,
        durationMs: Int? = nil,
        gapMs: Int? = nil
    ) {
        self.key = key
        self.modifiers = modifiers
        self.durationMs = durationMs
        self.gapMs = gapMs
    }

    private enum CodingKeys: String, CodingKey {
        case key
        case modifiers
        case durationMs = "duration_ms"
        case gapMs = "gap_ms"
    }
}

/// Discriminated-union payload for `HostAppControlRequest.input`. The wire
/// shape is `{ "tool": "<variant>", ...fields }` for each variant — Swift
/// hides the discriminator inside the enum case.
public enum HostAppControlInput: Codable, Equatable, Sendable {
    case start(app: String, args: [String]?)
    case observe(app: String, settleMs: Int?)
    case press(app: String, key: String, modifiers: [String]?, durationMs: Int?)
    case combo(app: String, keys: [String], durationMs: Int?)
    case sequence(app: String, steps: [HostAppControlSequenceStep])
    case type(app: String, text: String)
    case click(app: String, x: Double, y: Double, button: String?, double: Bool?)
    case drag(app: String, fromX: Double, fromY: Double, toX: Double, toY: Double, button: String?)
    case stop(app: String?, reason: String?)

    private enum CodingKeys: String, CodingKey {
        case tool
        case app
        case args
        case key
        case keys
        case modifiers
        // Wire format uses snake_case for multi-word fields (driven by
        // TOOLS.json schema property names). Map explicitly — without these
        // raw values, decode silently misses `duration_ms` / `from_x` / etc.
        // and hold-durations and drag coordinates fall through to defaults.
        case durationMs = "duration_ms"
        case settleMs = "settle_ms"
        case steps
        case text
        case x
        case y
        case button
        case double
        case fromX = "from_x"
        case fromY = "from_y"
        case toX = "to_x"
        case toY = "to_y"
        case reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let tool = try container.decode(String.self, forKey: .tool)
        switch tool {
        case "start":
            let app = try container.decode(String.self, forKey: .app)
            let args = try container.decodeIfPresent([String].self, forKey: .args)
            self = .start(app: app, args: args)
        case "observe":
            let app = try container.decode(String.self, forKey: .app)
            let settleMs = try container.decodeIfPresent(Int.self, forKey: .settleMs)
            self = .observe(app: app, settleMs: settleMs)
        case "press":
            let app = try container.decode(String.self, forKey: .app)
            let key = try container.decode(String.self, forKey: .key)
            let modifiers = try container.decodeIfPresent([String].self, forKey: .modifiers)
            let durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
            self = .press(app: app, key: key, modifiers: modifiers, durationMs: durationMs)
        case "combo":
            let app = try container.decode(String.self, forKey: .app)
            let keys = try container.decode([String].self, forKey: .keys)
            let durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
            self = .combo(app: app, keys: keys, durationMs: durationMs)
        case "sequence":
            let app = try container.decode(String.self, forKey: .app)
            let steps = try container.decode([HostAppControlSequenceStep].self, forKey: .steps)
            self = .sequence(app: app, steps: steps)
        case "type":
            let app = try container.decode(String.self, forKey: .app)
            let text = try container.decode(String.self, forKey: .text)
            self = .type(app: app, text: text)
        case "click":
            let app = try container.decode(String.self, forKey: .app)
            let x = try container.decode(Double.self, forKey: .x)
            let y = try container.decode(Double.self, forKey: .y)
            let button = try container.decodeIfPresent(String.self, forKey: .button)
            let double = try container.decodeIfPresent(Bool.self, forKey: .double)
            self = .click(app: app, x: x, y: y, button: button, double: double)
        case "drag":
            let app = try container.decode(String.self, forKey: .app)
            let fromX = try container.decode(Double.self, forKey: .fromX)
            let fromY = try container.decode(Double.self, forKey: .fromY)
            let toX = try container.decode(Double.self, forKey: .toX)
            let toY = try container.decode(Double.self, forKey: .toY)
            let button = try container.decodeIfPresent(String.self, forKey: .button)
            self = .drag(app: app, fromX: fromX, fromY: fromY, toX: toX, toY: toY, button: button)
        case "stop":
            let app = try container.decodeIfPresent(String.self, forKey: .app)
            let reason = try container.decodeIfPresent(String.self, forKey: .reason)
            self = .stop(app: app, reason: reason)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .tool,
                in: container,
                debugDescription: "Unknown HostAppControlInput tool: \(tool)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .start(let app, let args):
            try container.encode("start", forKey: .tool)
            try container.encode(app, forKey: .app)
            try container.encodeIfPresent(args, forKey: .args)
        case .observe(let app, let settleMs):
            try container.encode("observe", forKey: .tool)
            try container.encode(app, forKey: .app)
            try container.encodeIfPresent(settleMs, forKey: .settleMs)
        case .press(let app, let key, let modifiers, let durationMs):
            try container.encode("press", forKey: .tool)
            try container.encode(app, forKey: .app)
            try container.encode(key, forKey: .key)
            try container.encodeIfPresent(modifiers, forKey: .modifiers)
            try container.encodeIfPresent(durationMs, forKey: .durationMs)
        case .combo(let app, let keys, let durationMs):
            try container.encode("combo", forKey: .tool)
            try container.encode(app, forKey: .app)
            try container.encode(keys, forKey: .keys)
            try container.encodeIfPresent(durationMs, forKey: .durationMs)
        case .sequence(let app, let steps):
            try container.encode("sequence", forKey: .tool)
            try container.encode(app, forKey: .app)
            try container.encode(steps, forKey: .steps)
        case .type(let app, let text):
            try container.encode("type", forKey: .tool)
            try container.encode(app, forKey: .app)
            try container.encode(text, forKey: .text)
        case .click(let app, let x, let y, let button, let double):
            try container.encode("click", forKey: .tool)
            try container.encode(app, forKey: .app)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
            try container.encodeIfPresent(button, forKey: .button)
            try container.encodeIfPresent(double, forKey: .double)
        case .drag(let app, let fromX, let fromY, let toX, let toY, let button):
            try container.encode("drag", forKey: .tool)
            try container.encode(app, forKey: .app)
            try container.encode(fromX, forKey: .fromX)
            try container.encode(fromY, forKey: .fromY)
            try container.encode(toX, forKey: .toX)
            try container.encode(toY, forKey: .toY)
            try container.encodeIfPresent(button, forKey: .button)
        case .stop(let app, let reason):
            try container.encode("stop", forKey: .tool)
            try container.encodeIfPresent(app, forKey: .app)
            try container.encodeIfPresent(reason, forKey: .reason)
        }
    }
}

/// Cancellation signal from the daemon telling the client to abort an
/// in-flight host app-control action identified by `requestId`.
public struct HostAppControlCancel: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String

    public init(type: String, requestId: String) {
        self.type = type
        self.requestId = requestId
    }
}

/// Lifecycle state of the target app at the moment of observation.
public enum HostAppControlState: String, Codable, Equatable, Sendable {
    case running
    case missing
    case minimized
}

/// Window bounds in points for the focused window of the target app.
public struct WindowBounds: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// Payload posted back to the daemon with the result of a host app-control
/// action. `pngBase64` and `windowBounds` are present when a screenshot/
/// observation was captured; `executionResult`/`executionError` carry the
/// outcome of the executed action.
public struct HostAppControlResultPayload: Codable, Equatable, Sendable {
    public let requestId: String
    public let state: HostAppControlState
    public let pngBase64: String?
    public let windowBounds: WindowBounds?
    public let executionResult: String?
    public let executionError: String?

    public init(
        requestId: String,
        state: HostAppControlState,
        pngBase64: String? = nil,
        windowBounds: WindowBounds? = nil,
        executionResult: String? = nil,
        executionError: String? = nil
    ) {
        self.requestId = requestId
        self.state = state
        self.pngBase64 = pngBase64
        self.windowBounds = windowBounds
        self.executionResult = executionResult
        self.executionError = executionError
    }
}

public struct HostCuResultPayload: Codable, Sendable {
    public let requestId: String
    public let axTree: String?
    public let axDiff: String?
    public let screenshot: String?
    public let screenshotWidthPx: Int?
    public let screenshotHeightPx: Int?
    public let screenWidthPt: Int?
    public let screenHeightPt: Int?
    public let executionResult: String?
    public let executionError: String?
    public let secondaryWindows: String?
    public let userGuidance: String?

    public init(
        requestId: String,
        axTree: String?,
        axDiff: String?,
        screenshot: String?,
        screenshotWidthPx: Int?,
        screenshotHeightPx: Int?,
        screenWidthPt: Int?,
        screenHeightPt: Int?,
        executionResult: String?,
        executionError: String?,
        secondaryWindows: String?,
        userGuidance: String?
    ) {
        self.requestId = requestId
        self.axTree = axTree
        self.axDiff = axDiff
        self.screenshot = screenshot
        self.screenshotWidthPx = screenshotWidthPx
        self.screenshotHeightPx = screenshotHeightPx
        self.screenWidthPt = screenWidthPt
        self.screenHeightPt = screenHeightPt
        self.executionResult = executionResult
        self.executionError = executionError
        self.secondaryWindows = secondaryWindows
        self.userGuidance = userGuidance
    }

    private enum CodingKeys: String, CodingKey {
        case requestId
        case axTree
        case axDiff
        case screenshot
        case screenshotWidthPx
        case screenshotHeightPx
        case screenWidthPt
        case screenHeightPt
        case executionResult
        case executionError
        case secondaryWindows
        case userGuidance
    }
}

/// Server-side assistant activity lifecycle event.
/// Backed by generated `AssistantActivityState`.
public typealias AssistantActivityStateMessage = AssistantActivityState

/// Request a follow-up suggestion for the current conversation.
/// Backed by generated `SuggestionRequest`.
public typealias SuggestionRequestMessage = SuggestionRequest

extension SuggestionRequest {
    public init(conversationId: String, requestId: String) {
        self.init(type: "suggestion_request", conversationId: conversationId, requestId: requestId)
    }
}

/// Client response to a permission confirmation request.
/// Backed by generated `ConfirmationResponse`.
public typealias ConfirmationResponseMessage = ConfirmationResponse

extension ConfirmationResponse {
    public init(requestId: String, decision: String, selectedPattern: String? = nil, selectedScope: String? = nil) {
        self.init(type: "confirmation_response", requestId: requestId, decision: decision, selectedPattern: selectedPattern, selectedScope: selectedScope)
    }
}

/// Client response to a secret input request.
/// Backed by generated `SecretResponse`.
public typealias SecretResponseMessage = SecretResponse

extension SecretResponse {
    public init(requestId: String, value: String?, delivery: String? = nil) {
        self.init(type: "secret_response", requestId: requestId, value: value, delivery: delivery)
    }
}

/// Sent to add a trust rule (allowlist/denylist) independently of a confirmation response.
/// Backed by generated `AddTrustRule`.
public typealias AddTrustRuleMessage = AddTrustRule

extension AddTrustRule {
    public init(
        toolName: String,
        pattern: String,
        scope: String,
        decision: String,
        executionTarget: String? = nil
    ) {
        self.init(
            type: "add_trust_rule",
            toolName: toolName,
            pattern: pattern,
            scope: scope,
            decision: decision,
            executionTarget: executionTarget
        )
    }
}

/// Request all trust rules from the daemon.
/// Backed by generated `TrustRulesList`.
public typealias TrustRulesListMessage = TrustRulesList

extension TrustRulesList {
    public init() {
        self.init(type: "trust_rules_list")
    }
}

/// Remove a trust rule by its ID.
/// Backed by generated `RemoveTrustRule`.
public typealias RemoveTrustRuleMessage = RemoveTrustRule

extension RemoveTrustRule {
    public init(id: String) {
        self.init(type: "remove_trust_rule", id: id)
    }
}

/// Update fields on an existing trust rule.
/// Backed by generated `UpdateTrustRule`.
public typealias UpdateTrustRuleMessage = UpdateTrustRule

extension UpdateTrustRule {
    public init(id: String, tool: String? = nil, pattern: String? = nil, scope: String? = nil, decision: String? = nil, priority: Int? = nil) {
        self.init(type: "update_trust_rule", id: id, tool: tool, pattern: pattern, scope: scope, decision: decision, priority: priority)
    }
}

/// Simulate a tool permission check without executing the tool.
/// Backed by generated `ToolPermissionSimulateRequest`.
public typealias ToolPermissionSimulateMessage = ToolPermissionSimulateRequest

extension ToolPermissionSimulateRequest {
    public init(toolName: String, input: [String: AnyCodable], workingDir: String? = nil, isInteractive: Bool? = nil) {
        self.init(type: "tool_permission_simulate", toolName: toolName, input: input, workingDir: workingDir, isInteractive: isInteractive)
    }
}

/// Response from a tool permission simulation.
/// Backed by generated `ToolPermissionSimulateResponse`.
public typealias ToolPermissionSimulateResponseMessage = ToolPermissionSimulateResponse

/// Request the list of all registered tool names.
/// Backed by generated `ToolNamesListRequest`.
public typealias ToolNamesListMessage = ToolNamesListRequest

extension ToolNamesListRequest {
    public init() {
        self.init(type: "tool_names_list")
    }
}

/// Response containing all registered tool names.
/// Backed by generated `ToolNamesListResponse`.
public typealias ToolNamesListResponseMessage = ToolNamesListResponse

/// Response from opening and scanning a .vellum bundle.
/// Backed by generated `OpenBundleResponse`.
public typealias OpenBundleResponseMessage = OpenBundleResponse

// MARK: - Publish / Unpublish Page Messages

/// Sent to publish a static page via Vercel.
/// Backed by generated `PublishPageRequest`.
public typealias PublishPageRequestMessage = PublishPageRequest

extension PublishPageRequest {
    public init(html: String, title: String? = nil, appId: String? = nil) {
        self.init(type: "publish_page", html: html, title: title, appId: appId)
    }
}

/// Response from publishing a static page.
/// Backed by generated `PublishPageResponse`.
public typealias PublishPageResponseMessage = PublishPageResponse

/// Sent to unpublish a page and delete its Vercel deployment.
/// Backed by generated `UnpublishPageRequest`.
public typealias UnpublishPageRequestMessage = UnpublishPageRequest

extension UnpublishPageRequest {
    public init(deploymentId: String) {
        self.init(type: "unpublish_page", deploymentId: deploymentId)
    }
}

/// Response from unpublishing a page.
/// Backed by generated `UnpublishPageResponse`.
public typealias UnpublishPageResponseMessage = UnpublishPageResponse

// MARK: - Push Notification Device Token (Manual)

/// Sent to register an APNS device token so the daemon can route push notifications.
/// Kept hand-maintained — not yet part of the generated message contract.
