# Halo on reSpeaker Clip — what the prototype actually is, and the work to make it Cue

**Date:** 2026-08-30
**Prototype:** Seeed reSpeaker Clip (nRF5340 + nRF7002), $75.90, sample offered by Seeed
**Target:** `justcue.ai/halo.html` — "Wear your day. Cue handles the rest."
**Reference direction:** bee.computer
**Sources read:** `wiki.seeedstudio.com/respeaker_clip/`, the Basic SDK guide, `github.com/Seeed-Studio/reSpeaker_Clip` (firmware @ main, Apache-2.0), `docs/protocol.md` (2,782 lines), `docs/udp_protocol.md`, `mobile/README.md`

---

## 0. The headline

**The back half of Halo already exists in Cue and is production-tested.** Audio → transcript → structured extraction → action items → work items → triage → Activity is the same spine that voice-intake and meeting-recap run on today. Nothing about "understand my day and turn it into things to do" needs to be built.

**All of the work is the front half**: transport, a session/segmentation model for a *day* rather than a *meeting*, and two surfaces. Plus one thing Cue has learned the hard way and must not skip — a relevance gate before anything becomes a work item.

**One assumption in the brief needs correcting.** "The SDK and app is provided by reSpeaker" is *half* true and the half that's false is the expensive half:

- The Python host SDK is real, documented, and complete. Perfect for bench work.
- Flutter / Android / iOS SDKs **do exist** in `mobile/sdk/` (the wiki still says "coming soon" — the repo is ahead of the docs). `mobile/` sits outside the repo's Apache-2.0 grant, but **we hold commercial rights to all of it** under the Seeed engagement, so we can use and modify it freely. Not a blocker.
- The remaining half is real though: the demo app is a **Flutter** app, and Cue's mobile client is **Capacitor over the web SPA**. We are not "updating their app" — we wrap their native Swift/Kotlin SDK in a Capacitor plugin. Their Flutter app is a reference implementation to read (`mobile/app/docs/recording_flow.md` is the useful file), not a codebase to fork.

---

## 1. What the Clip actually is — the five facts that determine the architecture

### 1.1 It is a recorder, not a microphone

BLE 5.3 only. **No A2DP, no HFP, no Bluetooth audio profile at all.** The Clip will never appear as a system audio input device, which means:

- You cannot point Cue Live / `live-voice` at it. Not now, not with a firmware patch.
- Audio is captured to on-device storage as **Opus mono/stereo @ 16 kHz, 32 kbps**, in a raw framed format — `[2-byte LE length][opus frame]…`, *not* an OGG container. Everything (ffmpeg, Whisper, Deepgram) needs `convert_to_ogg_opus()` first.
- The interaction model is **record → sync → understand**, and every product decision follows from that.

### 1.2 …but "continuous sync" gets us close to live

Protocol §4.7: start recording, then immediately `AT+DOWNLOAD=<session_id>`, and the device streams segment files to the client *as they are written*, until `AT+STOP` produces `TRANSFER_DONE`. The reference `record.py` and `clip-web.py` both do this (`SessionSync(continuous=True)`).

The numbers say this is viable:

| | Rate |
|---|---|
| Audio produced | 32 kbps = **4 KB/s** |
| BLE @ MTU 517 | ~28 KB/s |
| BLE @ MTU 247 | ~22 KB/s |
| Wi-Fi UDP | ~500 KB/s |

**BLE has ~5× headroom over the audio rate.** Continuous sync over BLE keeps up in real time with room to spare. This is the single fact that makes an ambient product possible on this hardware.

Latency floor is the segment size. §6.2's own example — `duration: 600, files: 30` — implies **~20-second segment files**. So end-to-end "spoken → in Cue" ≈ 20 s + transfer + STT. Good enough for "what did I just agree to"; not good enough for conversational back-and-forth. **Verify on the bench** (it's a `CONFIG_CLIP_STORAGE_FILES_PER_GROUP`-adjacent build constant, not a promise).

### 1.3 Wi-Fi is an access point, not a client

`AT+WIFI` puts the device into **AP mode**: SSID `ClipAP_XXXX`, password `12345678`, `192.168.4.1:8089` UDP. The *phone* joins *it*. So Wi-Fi sync is 20× faster but costs the phone its internet connection for the duration, and on iOS needs the **Hotspot Configuration entitlement** (Seeed's own README says to enable it on the App ID).

→ **Wi-Fi is the end-of-day bulk catch-up path. BLE continuous sync is the live path.** Not interchangeable.

### 1.4 One bonded device, and re-pairing wipes the card

Protocol §10.3: **single bond policy.** The device stores keys for exactly one central; a new pairing clears the previous bond, and `AT+PAIR=reset` *formats the SD card*. Pairing is **LE Secure Connections with Just Works** — encrypted (AES-128-CCM) but unauthenticated, so no MITM protection; physical proximity at pairing time is the security model.

Two consequences:
- **You must choose: the Mac or the phone.** Not both, not simultaneously. Development on a Mac and dogfooding on a phone means re-pairing (and wiping) each time. Order two units.
- For a device that records someone's whole day, "unauthenticated pairing" belongs in the privacy stance, stated plainly.

### 1.5 The only user gesture available is the bookmark

One button, one vibration motor, one OLED, **no speaker**.

| Gesture | Behaviour |
|---|---|
| Single click while RECORDING | `AT+MARK` → adds a timestamped bookmark, emits `{"event":"mark",…}` |
| Long press >1s | Start/stop recording + haptic confirm |
| Long press 2/3/4s | Power-off flow |
| **Double click** | **Reserved — no action** |

There is **no AT command to write text to the OLED** (only `AT+BRIGHTNESS`), no wake-word engine, and no VAD event over BLE. So on stock firmware:

- Cue cannot speak or display a reply on the device. Responses go to the phone, the Mac, or the companion.
- **The bookmark is the intent verb.** A click while recording means "Cue, *this* matters." It is free, it is on the device, it needs no firmware, and it maps exactly onto Cue's existing capture model. Design the whole day-one interaction around it.
- Double-click is explicitly unclaimed — that's the push-to-talk gesture, when we're ready to touch firmware.

### 1.6 Prototype vs. the Halo page

| halo.html promises | Clip delivers |
|---|---|
| 8-mic array with beamforming | 2 PDM mics, 360° omni, ~3 m, SpeexDSP NR/AGC/dereverb — **no beamforming** |
| 14-hour battery | 14–18 h continuous recording ✅ |
| Haptic confirmations | Vibration motor ✅ |
| On-device processing before the app | SpeexDSP + Opus encode ✅ (no on-device ASR/LLM) |
| **A visible light whenever the array is live** | OLED only, brightness-controllable — **no app-controllable privacy light** |
| 18 g aerospace aluminium, three finishes | Plastic dev unit + magnetic charge base |

The prototype is a faithful functional stand-in for everything except beamforming and the privacy light. **It is more than good enough to build and validate the entire software product** — which is the point. Don't spend a day on industrial design.

---

## 2. What Cue already has (verified in-tree)

| Piece | Where | State |
|---|---|---|
| STT, batch, with ffmpeg chunking | `assistant/src/runtime/routes/stt-routes.ts` — `stt/transcribe` (base64) + `stt/transcribe-file` (path) | Live. 25 MB chunks, 10-min splits, `.ogg` already an accepted extension |
| STT providers | `providers/speech-to-text/` — deepgram, whisper, gemini, xai (+ realtime variants) | Live |
| Transcript → summary + action items → work items | `runtime/services/voice-intake.ts` (`capture_voice_intake` forced tool call) | Live |
| Long transcript → recap + graph memory | `runtime/services/meeting-recap.ts` | Live |
| Action items → executable work items, idempotent | `runtime/services/action-item-work-items.ts` | Live, shared by both |
| **Relevance gate** — deterministic rules → safety floor → model, fail-open | `assistant/src/arrivals/arrival-gate.ts` | Live. The design transfers directly |
| **Always-on capture governance** — armed expiring session, interval floor, extraction/item caps, change fingerprint, sensitive deny-list, `autoRunEligibility: "parked"` | `cue-live/observation-capture.ts` + `observation-driver.ts` | Live. This is the hard-won part, already written and tested |
| Notes capture surface + offline store + import + ask | `assistant/src/notes/`, `apps/web/src/domains/notes/` | Live, incl. a recording panel |
| Companion (always-on surface) | `apps/web/src/domains/companion/`, `apps/macos/src/main/companion-*` | In flight on this branch |
| Native sidecar spawn/supervise pattern | `apps/macos/src/main/sidecar/mac-helper.ts` + Swift helper | Live — the pattern for any capture binary |

**Read `docs/cue-observation-todo-spec.md` before starting.** Halo is the same shape as screen observation with a different sensor, and that spec already argued out the gating, the caps, and the "parked, never auto-runs" default. Reuse the conclusions; do not relitigate them.

---

## 3. The gap — six pieces of work

1. **Transport** — get Opus segments off the Clip and into the daemon.
2. **Codec** — raw framed Opus → OGG/Opus (trivial; ~30 lines, or ffmpeg).
3. **A day model** — sessions, segments, bookmarks, retention. New store + migration.
4. **Segmentation** — turn six hours of audio into episodes worth reasoning about.
5. **The gate** — decide which episodes are allowed to become work items.
6. **Surfaces** — a day timeline, and the companion as Halo's live face.

Only 3–6 are product. 1–2 are plumbing.

---

## 4. Phased plan

Estimates are engineering-days for one person on the existing spine, not calendar time.

### Phase 0 — Bench bring-up · 2–3 days · no Cue code · **harness built**

`hardware/halo-bench/` is ready to run — Seeed's Apache-2.0 async Python SDK in a venv, plus a `bench.py` whose subcommands each answer one of the questions below and write the numbers to `runs/` as JSON. `README.md` there is the runbook, in order. Two checks already pass with no hardware attached: `test_codec.py` proves the raw-Opus → OGG remux (synthesising the device's exact byte layout with ffmpeg and round-tripping it), and `test_cli.py` proves every subcommand dispatches.

Also try `AT+USB` → CDC+MSC: the Clip mounts as mass storage, which is a **zero-integration ingest path** (plug in, files appear) worth having as a fallback forever.

Measure and write down:
- Actual segment file duration and continuous-sync end-to-end latency
- Sustained BLE throughput and negotiated MTU on macOS and on iPhone
- Battery drain with continuous sync running all day (the spec's 14–18 h assumes recording, not streaming)
- **Transcription quality at 2–3 m in a real 4-person meeting**, `normal` vs `enhanced` mode — this is the go/no-go on the whole product
- Whether the stereo (2-channel) capture gives any usable speaker separation

**Do not skip this.** Every estimate below is conditional on the mic being good enough at conversational distance, and that is the one thing no document can tell us.

### Phase 1 — Desktop ingest · 4–6 days

The first real Cue integration, and the one that gets a working loop fastest.

- **A `clip-bridge` in the existing Swift mac-helper**, using CoreBluetooth, spawned and supervised by the `mac-helper.ts` pattern. *Recommended over Node BLE (`noble` on macOS is a maintenance liability) and over shipping a Python runtime.* Python stays the bench tool; Swift is the shipping path.
- Raw-Opus → OGG converter.
- `POST cuelive/halo-ingest`-style seam (mirror `cuelive/observation`) → `stt/transcribe-file` → transcript.
- Feed the transcript straight into `generateVoiceIntake` for the first end-to-end proof: **speak → 20 s later there's a work item in Activity.**

Ship that, dogfood it, then build the day model on top of what you learn.

### Phase 2 — The day model and segmentation · 8–12 days · the actual new engineering

This is where the product is won or lost. A day is not a meeting.

- **Store + migration** (`assistant/src/memory/migrations/NNN-*.ts`): `halo_sessions`, `halo_segments`, bookmarks, transcripts, provenance, retention policy. Text by default; raw audio retention is an explicit setting.
- **Segmentation into episodes**, using the signals actually available: bookmark marks (the strongest — a human labelled it), silence gaps, speaker change, calendar overlap (Cue has the calendar), topic shift.
- **Diarization.** `providers/speech-to-text/provider-catalog.ts` already tracks `supportsDiarization` (true for Deepgram), but the batch Deepgram adapter only passes `model`/`language`/`smart_format` — **`diarize` is catalogued but not wired on the batch path.** Without it, "who said what" is guesswork, and half of Halo's value is attribution. Small fix, high leverage.
- **The relevance gate, per episode, before anything becomes a work item.** Reuse `arrival-gate.ts`'s three-layer shape: deterministic rules → safety floor → model for the ambiguous middle, fail-open. Cue has already shipped the failure this prevents once — "101 things from email", where scoring ran *after* the insert. An always-on mic is that failure mode multiplied by every sentence of the day. **This is the highest-risk item in the plan.**
- Everything filed **`autoRunEligibility: "parked"`**, exactly as `observation-capture.ts` does. Halo proposes; it never acts unattended.
- Bookmark → a distinct, higher-confidence path: an explicitly marked moment skips the relevance gate's scepticism, because the user already voted.

### Phase 3 — Surfaces · 10–15 days

- **Day timeline** — the bee.computer surface, and the biggest net-new UI. Episodes down the day, each with transcript, people, decisions, proposed to-dos, and a link into the thread. Cue has no timeline today (Mission Control is lanes, Notes is a rail).
- **Companion as Halo's live face** — the in-flight companion is exactly the right home for "Halo is live / heard something / here's what I'd do." Its phase model (idle → listening → typing card) already fits; its window discipline is already solved.
- **Ask your day** — `notes/note-ask.ts` already does Q&A over a corpus. Point it at the day store rather than build a second one.
- **Halo status** — battery, storage, last sync, live/paused, in both desktop and mobile.

### Phase 4 — Mobile transport · 15–20 days + genuine unknowns

The hard one, and the one to schedule *after* the desktop loop is proving value.

- **Wrap, don't reimplement.** We own the rights to `mobile/sdk/ios` and `mobile/sdk/android`, so the Capacitor plugin wraps their Swift/Kotlin SDK rather than re-deriving the protocol. (Reimplementing is entirely feasible — §2–4 of `protocol.md` is a complete spec — but it would be ~5–8 days spent on something we already own.)
- **A Capacitor BLE plugin.** No BLE plugin in `apps/web/package.json` today. Either wrap Seeed's Swift/Kotlin SDK in our own plugin, or build on `@capacitor-community/bluetooth-le`. Native code in `apps/ios/App` and `apps/android` either way — note that `apps/ios/.../public/` is `cap sync` output, so the source lives in `apps/web/capacitor-shell/`.
- **iOS background reality.** BLE central background mode gives reconnection and characteristic notifications, not a guarantee of multi-hour sustained transfer; iOS will suspend the app. The honest model is **opportunistic sync — foreground, recently-active, and background-BLE wake — with the Clip's 2 GB / 250 h buffer covering the gaps.** That buffer is exactly why the device has it. Design for it rather than fighting it.
- Wi-Fi AP sync needs `NEHotspotConfiguration` + handling an internet-less network.
- Then phone → daemon: `stt/transcribe` takes base64, so the endpoint exists; needs chunked upload, retry, and an offline queue.

### Phase 5 — Firmware · optional · 5–10 days each

Apache-2.0, Zephyr / nRF Connect SDK, and `docs/protocol.md` Appendix F is a literal copy-paste walkthrough for adding an AT command. Worth doing once the product is proven:

- **Claim double-click as push-to-talk** — the one gesture the firmware explicitly reserves.
- **A display-text AT command** — lets Cue answer silently on the OLED, which closes the interaction loop without a phone. This is the difference between a recorder and a companion.
- **A privacy LED** matching what halo.html promises.
- `lib/` ships Lua — there may be on-device scripting worth understanding before writing C.

---

## 5. Decisions owed, and risks

1. **Phone or Mac?** Single-bond forces the choice. Recommendation: **the Mac is the dev host and the phone is the product** — but they cannot coexist on one unit, so order at least two, and accept that re-pairing formats the card.

2. **Transcription cost is the unit economics of the product.** Eight hours a day of cloud STT per user is a recurring cost that plausibly exceeds the hardware margin — at Deepgram-class list pricing this lands in the tens of dollars per user per month, and **that number needs confirming against real pricing before it's quoted to anyone.** The mitigations are strategic, not incidental: VAD/silence-stripping before STT (most of a day is silence — likely the single biggest lever), and **local Whisper on the user's own machine**. Cue is already one-instance-per-person, so local STT is genuinely on the table in a way it isn't for a multi-tenant competitor. That is a moat, not a workaround.

3. **Consent law is a product requirement, not a footnote.** Always-on recording is regulated differently across the UAE, EU, and US two-party-consent states. halo.html already promises "a visible light whenever the array is live" — the prototype has no app-controllable light, so on this hardware the affordance has to be the OLED, the haptic, or a firmware change. Decide the policy before the first outside demo.

4. **Retention.** How long does raw audio live? Default should be: transcribe, extract, **discard the audio**, keep the text — matching what `observation-capture.ts` already does with frames (fingerprint only, frames never persisted). Deviating from that needs a reason.

5. **Sensitive-context muting.** The screen pipeline has `DEFAULT_SENSITIVE_APP_DENY_LIST`. Audio has no equivalent and needs one — a time/place/calendar-based mute, plus a one-press pause that is obvious enough to actually get used.

6. **Beamforming gap.** Two omni mics vs. the promised array. If Phase 0 shows the mic can't handle a 4-person table at 2–3 m, that reshapes the hardware spec — which is exactly what a prototype is for, and better learned now than after tooling.

---

## 6. Sequencing recommendation

Phase 0 → Phase 1 → dogfood for a week on the Mac → Phase 2 → Phase 3 → Phase 4.

The temptation is to start with the phone because that's the shipping product. Resist it: **the Mac path reaches a working "wear it, get action items" loop in under two weeks** with no BLE plugin, no App Store, no background-execution fight, and no licence question — and everything learned there (segmentation, the gate, the timeline, what's actually worth surfacing) is exactly what the phone will need. Phase 4 is transport for a product that already works.
