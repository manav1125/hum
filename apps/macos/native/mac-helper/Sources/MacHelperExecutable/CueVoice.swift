import AppKit
import AVFoundation
import CoreGraphics
import Foundation

// Cue Live voice I/O — push-to-talk speech-to-text (AssemblyAI streaming) and
// text-to-speech replies (ElevenLabs).
//
// Portions of this file are adapted from `clicky` by Farza
// (https://github.com/farzaa/clicky), used under the MIT License:
//
//   Copyright (c) 2026 Farza
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the "Software"),
//   to deal in the Software without restriction... (MIT License — full text in
//   THIRD-PARTY-NOTICES).
//
// Adaptations: the AssemblyAI streaming session authenticates with the user's
// API key directly (no token proxy / Cloudflare Worker), the ElevenLabs client
// calls the public API directly, and the push-to-talk monitor is reduced to the
// ctrl+option modifier-hold gesture. The brain (Claude) is NOT here — the Cue
// daemon owns model calls; this file only listens and speaks.

// MARK: - PCM16 conversion (adapted from clicky BuddyAudioConversionSupport)

/// Converts arbitrary-format `AVAudioPCMBuffer`s into 16 kHz, mono, signed
/// 16-bit little-endian PCM `Data` — the format AssemblyAI's stream expects.
final class CuePCM16AudioConverter {
    private let targetAudioFormat: AVAudioFormat
    private var audioConverter: AVAudioConverter?
    private var currentInputFormatDescription: String?

    init(targetSampleRate: Double) {
        self.targetAudioFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: true
        )!
    }

    func convertToPCM16Data(from audioBuffer: AVAudioPCMBuffer) -> Data? {
        let inputFormatDescription = audioBuffer.format.settings.description
        if currentInputFormatDescription != inputFormatDescription {
            audioConverter = AVAudioConverter(from: audioBuffer.format, to: targetAudioFormat)
            currentInputFormatDescription = inputFormatDescription
        }
        guard let audioConverter else { return nil }

        let sampleRateRatio = targetAudioFormat.sampleRate / audioBuffer.format.sampleRate
        let outputFrameCapacity = AVAudioFrameCount(
            (Double(audioBuffer.frameLength) * sampleRateRatio).rounded(.up) + 32
        )
        guard
            let outputBuffer = AVAudioPCMBuffer(
                pcmFormat: targetAudioFormat, frameCapacity: outputFrameCapacity)
        else { return nil }

        var hasProvidedSourceBuffer = false
        var conversionError: NSError?
        let status = audioConverter.convert(to: outputBuffer, error: &conversionError) {
            _, outStatus in
            if hasProvidedSourceBuffer {
                outStatus.pointee = .noDataNow
                return nil
            }
            hasProvidedSourceBuffer = true
            outStatus.pointee = .haveData
            return audioBuffer
        }
        guard status != .error else { return nil }
        guard let pcm = outputBuffer.audioBufferList.pointee.mBuffers.mData else { return nil }
        let bytesPerFrame = Int(targetAudioFormat.streamDescription.pointee.mBytesPerFrame)
        let byteCount = Int(outputBuffer.frameLength) * bytesPerFrame
        guard byteCount > 0 else { return nil }
        return Data(bytes: pcm, count: byteCount)
    }
}

// MARK: - AssemblyAI streaming session (adapted from clicky)

/// One websocket transcription session against AssemblyAI's v3 realtime API,
/// authenticated with the user's API key directly in the Authorization header.
final class CueAssemblyAISession: NSObject, @unchecked Sendable {
    private struct MessageEnvelope: Decodable { let type: String }
    private struct TurnMessage: Decodable {
        let transcript: String?
        let turn_order: Int?
        let end_of_turn: Bool?
        let turn_is_formatted: Bool?
    }
    private struct ErrorMessage: Decodable {
        let error: String?
        let message: String?
    }
    private struct StoredTurn { var text: String; var isFormatted: Bool }

    private static let baseURL = "wss://streaming.assemblyai.com/v3/ws"
    private static let targetSampleRate = 16_000.0
    private static let graceSeconds = 1.4

    private let apiKey: String
    private let onFinal: @Sendable (String) -> Void
    private let onError: @Sendable (Error) -> Void

    private let stateQueue = DispatchQueue(label: "com.cue.assemblyai.state")
    private let sendQueue = DispatchQueue(label: "com.cue.assemblyai.send")
    private let converter = CuePCM16AudioConverter(targetSampleRate: targetSampleRate)
    private let urlSession = URLSession(configuration: .default)

    private var task: URLSessionWebSocketTask?
    private var readyContinuation: CheckedContinuation<Void, Error>?
    private var resolvedReady = false
    private var deliveredFinal = false
    private var awaitingFinal = false
    private var latestText = ""
    private var activeTurnOrder: Int?
    private var activeTurnText = ""
    private var storedTurns: [Int: StoredTurn] = [:]
    private var deadline: DispatchWorkItem?

    init(
        apiKey: String,
        onFinal: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) {
        self.apiKey = apiKey
        self.onFinal = onFinal
        self.onError = onError
    }

    func open() async throws {
        var comps = URLComponents(string: Self.baseURL)!
        comps.queryItems = [
            URLQueryItem(name: "sample_rate", value: "16000"),
            URLQueryItem(name: "encoding", value: "pcm_s16le"),
            URLQueryItem(name: "format_turns", value: "true"),
        ]
        var request = URLRequest(url: comps.url!)
        request.setValue(apiKey, forHTTPHeaderField: "Authorization")
        let task = urlSession.webSocketTask(with: request)
        self.task = task
        task.resume()
        receiveNext()
        try await withCheckedThrowingContinuation { continuation in
            stateQueue.async { self.readyContinuation = continuation }
        }
    }

    func appendAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        guard let data = converter.convertToPCM16Data(from: buffer), !data.isEmpty else { return }
        sendQueue.async { [weak self] in
            self?.task?.send(.data(data)) { [weak self] error in
                if let error { self?.fail(error) }
            }
        }
    }

    func requestFinalTranscript() {
        stateQueue.async {
            guard !self.deliveredFinal else { return }
            self.awaitingFinal = true
            self.scheduleDeadline()
        }
        sendJSON(["type": "ForceEndpoint"])
    }

    func cancel() {
        stateQueue.async {
            self.deadline?.cancel()
            self.deadline = nil
        }
        sendJSON(["type": "Terminate"])
        task?.cancel(with: .goingAway, reason: nil)
    }

    private func receiveNext() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text): self.handleText(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) { self.handleText(text) }
                @unknown default: break
                }
                self.receiveNext()
            case .failure(let error):
                self.fail(error)
            }
        }
    }

    private func handleText(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        do {
            let envelope = try JSONDecoder().decode(MessageEnvelope.self, from: data)
            switch envelope.type.lowercased() {
            case "begin":
                resolveReady(.success(()))
            case "turn":
                handleTurn(try JSONDecoder().decode(TurnMessage.self, from: data))
            case "termination":
                resolveReady(.success(()))
                stateQueue.async {
                    if self.awaitingFinal && !self.deliveredFinal {
                        self.deliverFinal(self.bestText())
                    }
                }
            case "error":
                let e = try JSONDecoder().decode(ErrorMessage.self, from: data)
                fail(
                    NSError(
                        domain: "CueAssemblyAI", code: -1,
                        userInfo: [
                            NSLocalizedDescriptionKey: e.error ?? e.message ?? "AssemblyAI error"
                        ]))
            default: break
            }
        } catch {
            fail(error)
        }
    }

    private func handleTurn(_ turn: TurnMessage) {
        let text = turn.transcript?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        stateQueue.async {
            let order =
                turn.turn_order ?? self.activeTurnOrder ?? ((self.storedTurns.keys.max() ?? -1) + 1)
            if turn.end_of_turn == true || turn.turn_is_formatted == true {
                self.activeTurnOrder = nil
                self.activeTurnText = ""
                if !text.isEmpty {
                    if let existing = self.storedTurns[order], existing.isFormatted,
                        turn.turn_is_formatted != true
                    {
                        // keep the formatted one
                    } else {
                        self.storedTurns[order] = StoredTurn(
                            text: text, isFormatted: turn.turn_is_formatted == true)
                    }
                }
            } else {
                self.activeTurnOrder = order
                self.activeTurnText = text
            }
            self.latestText = self.compose()
            guard self.awaitingFinal else { return }
            if turn.end_of_turn == true || turn.turn_is_formatted == true {
                self.deadline?.cancel()
                self.deadline = nil
                self.deliverFinal(self.bestText())
            }
        }
    }

    private func compose() -> String {
        var segments = storedTurns.sorted { $0.key < $1.key }.map(\.value.text).filter {
            !$0.isEmpty
        }
        let active = activeTurnText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !active.isEmpty { segments.append(active) }
        return segments.joined(separator: " ")
    }

    private func bestText() -> String {
        let composed = compose().trimmingCharacters(in: .whitespacesAndNewlines)
        return composed.isEmpty
            ? latestText.trimmingCharacters(in: .whitespacesAndNewlines) : composed
    }

    private func scheduleDeadline() {
        deadline?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.stateQueue.async { self?.deliverFinal(self?.bestText() ?? "") }
        }
        deadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.graceSeconds, execute: work)
    }

    private func deliverFinal(_ text: String) {
        guard !deliveredFinal else { return }
        deliveredFinal = true
        deadline?.cancel()
        deadline = nil
        onFinal(text)
        sendJSON(["type": "Terminate"])
    }

    private func sendJSON(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
            let string = String(data: data, encoding: .utf8)
        else { return }
        sendQueue.async { [weak self] in
            self?.task?.send(.string(string)) { [weak self] error in
                if let error { self?.fail(error) }
            }
        }
    }

    private func fail(_ error: Error) {
        resolveReady(.failure(error))
        stateQueue.async {
            let text = self.bestText()
            if self.awaitingFinal && !self.deliveredFinal && !text.isEmpty {
                self.deliverFinal(text)
                return
            }
            self.onError(error)
        }
    }

    private func resolveReady(_ result: Result<Void, Error>) {
        stateQueue.async {
            guard !self.resolvedReady else { return }
            self.resolvedReady = true
            switch result {
            case .success: self.readyContinuation?.resume()
            case .failure(let e): self.readyContinuation?.resume(throwing: e)
            }
            self.readyContinuation = nil
        }
    }
}

// MARK: - Push-to-talk monitor (adapted from clicky GlobalPushToTalkShortcutMonitor)

/// Listen-only CGEvent tap that fires `onPressed` when ctrl+option go down
/// together and `onReleased` when they come back up — a modifier-hold
/// push-to-talk gesture. Requires Accessibility (already granted for Cue Live).
final class CuePushToTalkMonitor: @unchecked Sendable {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var pressed = false
    var onPressed: (() -> Void)?
    var onReleased: (() -> Void)?

    func start() {
        guard tap == nil else { return }
        let mask =
            (CGEventMask(1) << CGEventType.flagsChanged.rawValue)
            | (CGEventMask(1) << CGEventType.keyDown.rawValue)
            | (CGEventMask(1) << CGEventType.keyUp.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            guard let userInfo else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<CuePushToTalkMonitor>.fromOpaque(userInfo)
                .takeUnretainedValue()
            return monitor.handle(type: type, event: event)
        }
        guard
            let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                eventsOfInterest: mask, callback: callback,
                userInfo: Unmanaged.passUnretained(self).toOpaque())
        else { return }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return
        }
        self.tap = tap
        self.source = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    func stop() {
        pressed = false
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            self.source = nil
        }
        if let tap {
            CFMachPortInvalidate(tap)
            self.tap = nil
        }
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        guard type == .flagsChanged else { return Unmanaged.passUnretained(event) }
        let flags = NSEvent.ModifierFlags(rawValue: UInt(event.flags.rawValue))
            .intersection(.deviceIndependentFlagsMask)
        let down = flags.contains([.control, .option])
        if down && !pressed {
            pressed = true
            onPressed?()
        } else if !down && pressed {
            pressed = false
            onReleased?()
        }
        return Unmanaged.passUnretained(event)
    }
}

// MARK: - Voice controller

/// Owns push-to-talk capture (mic → AssemblyAI) and TTS playback (ElevenLabs).
/// Keys are injected from the app (Cue's settings), never embedded.
final class CueVoiceController: @unchecked Sendable {
    private var assemblyAiKey: String?
    private var elevenLabsKey: String?
    private var elevenLabsVoiceId = "21m00Tcm4TlvDq8ikWAM"  // ElevenLabs "Rachel"

    private let audioEngine = AVAudioEngine()
    private var session: CueAssemblyAISession?
    private var listening = false
    private var ttsPlayer: AVAudioPlayer?

    /// Called with the final transcript when the user finishes speaking.
    var onTranscript: ((String) -> Void)?
    /// Called when listening starts/stops (for overlay state).
    var onListeningChanged: ((Bool) -> Void)?

    var canTranscribe: Bool { (assemblyAiKey?.isEmpty == false) }
    var canSpeak: Bool { (elevenLabsKey?.isEmpty == false) }

    func setConfig(assemblyAiKey: String?, elevenLabsKey: String?, voiceId: String?) {
        self.assemblyAiKey = (assemblyAiKey?.isEmpty == false) ? assemblyAiKey : nil
        self.elevenLabsKey = (elevenLabsKey?.isEmpty == false) ? elevenLabsKey : nil
        if let voiceId, !voiceId.isEmpty { self.elevenLabsVoiceId = voiceId }
    }

    // MARK: Listening

    func startListening() {
        guard let key = assemblyAiKey, !listening else { return }
        listening = true
        onListeningChanged?(true)
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            guard let self else { return }
            guard granted else {
                self.listening = false
                self.onListeningChanged?(false)
                FileHandle.standardError.write(
                    Data("[cue-voice] microphone permission denied\n".utf8))
                return
            }
            let session = CueAssemblyAISession(
                apiKey: key,
                onFinal: { [weak self] text in
                    self?.finishListening(with: text)
                },
                onError: { error in
                    FileHandle.standardError.write(
                        Data("[cue-voice] STT error: \(error.localizedDescription)\n".utf8))
                })
            Task { [weak self] in
                do {
                    try await session.open()
                    self?.session = session
                    self?.startAudioEngine()
                } catch {
                    self?.listening = false
                    self?.onListeningChanged?(false)
                    FileHandle.standardError.write(
                        Data("[cue-voice] STT open failed: \(error.localizedDescription)\n".utf8))
                }
            }
        }
    }

    func stopListening() {
        guard listening else { return }
        listening = false
        onListeningChanged?(false)
        teardownAudioEngine()
        session?.requestFinalTranscript()
    }

    private func startAudioEngine() {
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.session?.appendAudioBuffer(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            FileHandle.standardError.write(
                Data("[cue-voice] audio engine failed: \(error.localizedDescription)\n".utf8))
        }
    }

    private func teardownAudioEngine() {
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
    }

    private func finishListening(with text: String) {
        let session = self.session
        self.session = nil
        session?.cancel()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        onTranscript?(trimmed)
    }

    // MARK: Speaking (ElevenLabs)

    func speak(_ text: String) {
        guard let key = elevenLabsKey,
            let url = URL(
                string:
                    "https://api.elevenlabs.io/v1/text-to-speech/\(elevenLabsVoiceId)?output_format=mp3_44100_128"
            )
        else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        let body: [String: Any] = [
            "text": text,
            "model_id": "eleven_flash_v2_5",
            "voice_settings": ["stability": 0.5, "similarity_boost": 0.75],
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self, let data, error == nil,
                let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode)
            else {
                let detail = error?.localizedDescription ?? "HTTP error"
                FileHandle.standardError.write(Data("[cue-voice] TTS failed: \(detail)\n".utf8))
                return
            }
            DispatchQueue.main.async {
                self.ttsPlayer = try? AVAudioPlayer(data: data)
                self.ttsPlayer?.play()
            }
        }.resume()
    }

    func stopSpeaking() {
        ttsPlayer?.stop()
        ttsPlayer = nil
    }
}
