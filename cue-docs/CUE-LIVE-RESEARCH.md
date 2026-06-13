# Cue Live — Landscape Research (desktop AI presence / "AI that lives on your screen")

_Researched 2026-06-13. Grounds the "Cue Live" concept (cursor companion + screen watch +
take-control) before we mock & spec. All fork candidates verified MIT-licensed._

## 1. The reference you found — clicky (farzaa/clicky)
- **What it is:** MIT-licensed, native-Swift macOS **menu-bar app** — "an AI teacher that lives
  as a buddy next to your cursor. It can see your screen, talk to you, and even point at stuff."
  ~5k stars, 901 forks.
- **Architecture:** two `NSPanel` windows — a control-panel dropdown + a **full-screen
  transparent cursor overlay**. Push-to-talk (Control+Option) streams audio → AssemblyAI (STT)
  → sends transcript + **screenshot** to Claude over streaming SSE → speaks back via ElevenLabs
  TTS. Claude embeds `[POINT:x,y:label:screenN]` tags so the **cursor flies to UI elements**
  across multiple monitors. All API keys held in a Cloudflare Worker proxy (never in the binary).
- **What it does / doesn't:** it **guides and points**; it does **not take control** (no
  clicking/typing for you). It uses **screenshot-on-hotkey**, not continuous accessibility-tree
  reading. macOS 14.2+ (ScreenCaptureKit), needs Mic + Accessibility + Screen Recording.
- **Verdict:** an excellent, proven reference for the **companion overlay + voice loop + point**
  UX — but narrow (single-purpose Swift app, no memory, no automation). **Borrow the mechanic,
  don't fork as the base.**

## 2. The 2026 landscape — three camps

**A. Screen-aware copilots (see + suggest; mostly don't act).** Validates our wedge.
- **Cluely** — "undetectable" overlay that watches screen + audio in meetings/calls and feeds
  you answers. Raised **$15M from a16z at ~$120M (Jun 2025)**. A **2025 breach hit 83k+ users** —
  a cautionary tale about always-capturing the screen to the cloud.
- **Highlight AI** — always-on desktop assistant that can see any app, voice input, model picker
  with BYO models. **$40M Series A (Khosla, Mar 2026)**. The "read your screen" wave is real money.

**B. Recall / always-on memory.** Cautionary tales on privacy + business model.
- **Rewind → Limitless** — pivoted from local-first Mac screen-recall to a **$99 pendant** (2024),
  went cloud, then **acquired by Meta (Dec 2025)** and the Mac app was **shut down**. Lesson:
  always-on screen recording as a standalone product is fragile; trust + durability matter.
- **Screenpipe** (YC S26, **MIT**) — local-first, records screen + app text + audio 24/7, stored
  on-device, "context layer for AI agents." Strong OSS reference for our **scoped-watch / recall**.

**C. Take-control / computer-use agents.** The hard frontier.
- **Anthropic Computer Use** (Oct 2024) and **OpenAI Operator → ChatGPT Agent** (2025).
- **Reliability (OSWorld):** Operator ~**38%**, **Claude Sonnet 4.6 ~73%** (verified); best
  open-source **OpenCUA ~45%** (SOTA open); some claim higher with custom harnesses. Takeaway:
  multi-step, complex-app control is **still unreliable** — design for it, don't promise it.
- **Apple Intelligence Actions** becoming meaningful through 2026 (native OS automation).

## 3. The technical fork in the road — AX tree vs screenshots (the key design input)
| Approach | Speed | Permission | Privacy | Weakness |
| --- | --- | --- | --- | --- |
| **Accessibility tree (AX)** | ~50ms reads, **40–100× faster** | Accessibility only | **No images leave device** | Blind in canvas apps (Figma, video, games) |
| **Screenshot + vision** | 2–5s round trip | Screen Recording | Sends screen images to cloud | Slow, costly, less precise |
| **Hybrid (AX + screenshot)** | fast where it can be | both | tunable | most complex to build — **and the winner** |

AX gives stable roles (`AXButton`) + labels (`AXTitle`) + exact coordinates, so clicks land
reliably without pixel-guessing. **AX-first, screenshots only when AX is blind** is the right
default — faster, cheaper, and far more private. (clicky is screenshot-based; Fazm is AX-first.)

## 4. Fork / borrow candidates (all MIT — compatible with our MIT vellum fork)
- **clicky** (MIT, Swift) — overlay + point + push-to-talk voice loop. Borrow the **companion UX**.
- **Fazm** (`github.com/mediar-ai/fazm`, MIT, Swift) — **AX-first**, voice, full desktop automation,
  local-first. The strongest reference (and possible engine) for **take-control on macOS**.
- **Screenpipe** (MIT, YC S26) — local-first 24/7 capture. Reference for **scoped-watch / recall**.
- **MCP desktop-control servers** — `macos-use` / `MacOS-MCP` / `mcp-remote-macos-use` /
  Open Computer Use (all MIT): expose `list_apps`, `get_app_state`, `click`, `type_text`,
  `set_value`, etc. **This is the big one:** our vellum fork is **MCP-native**, so we can plug a
  macOS-control MCP in rather than building control from scratch.

## 5. What this means for Cue (strategy)
1. **The market is validated and funded** (Cluely, Highlight) — but they're thin: screen-readers
   without durable memory or cross-surface identity. **Our edge is the assistant behind it** —
   8-type memory, one brain across desktop/web/mobile/voice, and the trust console. Cue Live is a
   *surface* of Cue, not a standalone gimmick.
2. **Privacy is the battleground, and it's ours to win.** Every cloud-capture product got punished
   (Cluely breach; Limitless/Meta shutdown). Our **self-host + local-first + AX-first (no
   screenshots by default) + consent console** is a real, defensible differentiator.
3. **Respect the reliability ceiling.** Best take-control is ~73% on benchmarks. So: **guide-first**
   everywhere, **take-control where AX makes it reliable** (email, forms, web, structured business
   apps), **checkpoints + always-win stop**, and treat complex creative apps (Figma, video) as
   guide-only until vision reliability improves. Don't overpromise autonomy.
4. **Compose, don't rebuild.** Keep vellum as the core; borrow clicky's overlay UX; integrate an
   MCP macOS-control server (or Fazm's AX engine) for actions; adopt Screenpipe-style local capture
   for watch mode. Vellum already has computer-use, MCP, approvals, and CES isolation to slot into.

## 6. Recommended architecture for Cue Live (to design against)
- **Native macOS helper** (the fork already ships `vellum-mac-helper.app`) hosts: AX reader,
  ScreenCaptureKit (on-demand), CGEvent actions, and the **transparent click-through overlay**.
- **Tiered observation:** AX tree (local, cheap) → local gate "is anything actionable?" →
  screenshot only on meaningful change / when summoned → cloud model for reasoning. Redact
  password fields + user-flagged apps.
- **Action layer via MCP** (`macos-use`-style) so it's sandboxed and reuses the approvals model.
- **Modes:** Companion (cursor) · Scoped watch · Full-screen always-on · Take-control (guided →
  autonomous). All governed by the trust/consent console (recording light, one-tap pause).
- **Everything feeds the same memory + next-moves queue** — Cue Live is desktop ambient capture,
  the sibling of the wearable.

## 7. Open questions for the spec
- Native Swift overlay/AX (like clicky/Fazm) vs. bridging through the existing Electron app?
- Build AX engine ourselves vs. embed Fazm vs. consume a macOS-control MCP?
- Local model for the "actionable?" gate (cost/privacy) — which one?
- Default capture posture: AX-only (no screen images) until the user opts into vision?

## Sources
- clicky: https://github.com/farzaa/clicky
- AI-that-reads-your-screen overview: https://www.shadow.do/blog/ai-that-reads-your-screen-on-mac-2026
- Cluely review/funding: https://aiinsightsnews.net/cluely-ai/ · https://dupple.com/tools/cluely
- Highlight AI / market: https://www.shadow.do/blog/ai-that-reads-your-screen-on-mac-2026
- Computer-use reliability: https://www.digitalapplied.com/blog/computer-use-agents-2026-claude-openai-gemini-matrix · https://coasty.ai/blog/osworld-benchmark-2026-82-percent-vs-everyone-else
- OSWorld benchmark: https://openreview.net/forum?id=tN61DTr4Ed · https://arxiv.org/abs/2508.09123 (OpenCUA)
- Limitless/Rewind history: https://birchtree.me/blog/limitless-just-got-sherlocked-by-microsoft/ · https://andrewschreiber.substack.com/p/an-early-adopters-thoughts-on-rewindais
- Screenpipe (OSS, MIT): https://github.com/screenpipe/screenpipe
- Fazm (OSS, MIT, AX-first): https://github.com/mediar-ai/fazm · https://fazm.ai/blog/macos-ai-agent-accessibility-screencapturekit
- AX vs screenshot deep dive: https://earezki.com/ai-news/2026-03-17-what-we-learned-building-a-macos-ai-agent-in-swift-screencapturekit-accessibility-apis-async-pipelines/
- macOS AX CLI for agents: https://github.com/andelf/axcli
- macOS-control MCP servers: https://github.com/baryhuang/mcp-remote-macos-use · https://github.com/CursorTouch/MacOS-MCP
