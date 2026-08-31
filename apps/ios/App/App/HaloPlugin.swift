import Capacitor
import HaloKit
import SwiftUI
import UIKit

/// The bridge: Halo's native surfaces, presented from the web app.
///
/// Cue's mobile client is a web SPA in a WKWebView, and almost everything
/// belongs there. Halo does not. Its whole design rests on matched-geometry
/// transitions, a sky-clock gradient interpolating in real time, a haptics
/// map, and a sun path shared with a widget extension — none of which a web
/// view can do convincingly, and the design's own handoff says not to ship the
/// flat version to real users.
///
/// So the SPA owns navigation and Halo owns its screens: JS calls
/// `Halo.openDay()` and a SwiftUI view controller comes up over the web view.
/// The seam is deliberately narrow — open a surface, close it, hand back what
/// the person did — because every capability that crosses it has to be
/// maintained twice.
@objc(HaloPlugin)
public class HaloPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HaloPlugin"
    public let jsName = "Halo"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openDay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openRecap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openOnboarding", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise)
    ]

    private var client: HaloClient?

    /// The SPA already holds the instance URL and the session token; passing
    /// them in beats a second copy of auth on this side that could disagree
    /// about which instance the person is signed into.
    @objc func configure(_ call: CAPPluginCall) {
        guard
            let baseURL = call.getString("baseURL").flatMap(URL.init(string:)),
            let token = call.getString("token")
        else {
            call.reject("baseURL and token are required")
            return
        }
        client = HaloClient(baseURL: baseURL, token: token)
        call.resolve()
    }

    @objc func openDay(_ call: CAPPluginCall) {
        present(call) { client in
            let day = try await client.today()
            return AnyView(DayCoverView(day: day))
        }
    }

    @objc func openQueue(_ call: CAPPluginCall) {
        present(call) { client in
            let queue = try await client.proposals()
            return AnyView(
                QueueView(
                    proposals: queue.proposals,
                    ledger: queue.ledger,
                    onAccept: { proposal in
                        Task { try? await client.accept(proposalId: proposal.id) }
                    },
                    onDismiss: { proposal in
                        Task { try? await client.dismiss(proposalId: proposal.id) }
                    }
                )
            )
        }
    }

    @objc func openRecap(_ call: CAPPluginCall) {
        present(call) { client in
            let day = try await client.today()
            // Receipts come from the day's own accepted work; until the daemon
            // serves them, the recap shows the day without inventing rows —
            // an empty receipt list is honest, a fabricated one is not.
            return AnyView(DayCloseView(day: day, receipts: []))
        }
    }

    @objc func openOnboarding(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.show(AnyView(OnboardingView(step: .promise)))
            call.resolve()
        }
    }

    // MARK: - Presentation

    /// Fetch, then present. Failures become the card state the design already
    /// draws rather than a rejected promise the SPA would have to render.
    private func present(
        _ call: CAPPluginCall,
        build: @escaping (HaloClient) async throws -> AnyView
    ) {
        guard let client else {
            call.reject("Halo is not configured")
            return
        }
        Task { @MainActor in
            do {
                let view = try await build(client)
                show(view)
                call.resolve()
            } catch let error as HaloClient.HaloClientError {
                show(AnyView(
                    HaloCardView(
                        state: error.cardState,
                        sync: HaloSync(state: "unknown", behindSeconds: nil)
                    )
                    .padding(20)
                ))
                call.resolve(["state": String(describing: error.cardState)])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @MainActor
    private func show(_ view: AnyView) {
        guard let presenter = bridge?.viewController else { return }
        let host = UIHostingController(rootView: view)
        host.modalPresentationStyle = .fullScreen
        // The sky paints edge to edge; a system background behind it would
        // show through during the transition.
        host.view.backgroundColor = .black
        presenter.present(host, animated: true)
    }
}
