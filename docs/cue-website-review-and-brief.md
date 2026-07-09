# justcue.ai — offering vs. reality audit + Claude Design brief

_Prepared 2026-07-09, grounded in the same night's live prod QA of `manav.justcue.app` (chat, voice, agents, work-items, projects, memory, skills, tools, connectors all exercised)._

The site is **ambitious and well-written** — it tells the full vision compellingly. The risk is that it sells the *vision* as *"Real software. Already shipping"* while meaningful chunks are still aspirational. Since Cue's own brand promise is **"powerful because it's principled"**, the credibility gap is the thing most worth fixing — an honesty pass *strengthens* the pitch, it doesn't weaken it.

---

## A. What the site claims that is REAL (verified working tonight) — sell these harder

These are true and demoable. They are the core magic and should lead:

| Claim | Reality (verified) |
|---|---|
| Chat with one memory across everything | ✅ works; 20+ live memory items, recall in-conversation |
| 8 kinds of memory with provenance + confidence | ✅ the memory system is real and populated |
| Agents / AI org with charters, budgets, spend | ✅ 3 agents, real per-agent spend endpoint |
| Runs autonomously in the background | ✅ heartbeat on (30-min cadence), 27 live work-items, triage→run→review loop |
| Missions / Work OS (goals → sprints → shipped) | ✅ projects + work-items live |
| Create Studio (decks, docs, models, PDFs, video) | ✅ all flagship tools registered (spreadsheet, deck/pdf export, video_compose) |
| Voice as a surface (talk, transcribe, act) | ✅ live — STT (Deepgram) + brain (Gemini) + TTS (ElevenLabs), now a beautiful amplitude-reactive orb |
| People / relationship memory + dossiers | ✅ contacts + dossier endpoints live |
| Connectors — "your whole stack" | ✅ ~500 connector apps via MCP |
| Trust / Guardrails / "Stop always wins" / your cloud, your keys | ✅ permission model + self-host are real and **under-sold** |

**Under-sold strengths (reality > site):** the **self-host "your cloud, your keys"** privacy moat, the **honest provenance/confidence** on memory, and the **to-do-list-that-does-itself work loop** are genuine, rare differentiators. Today they're features in a long list; they deserve to be headline pillars.

---

## B. What the site claims that is NOT yet real (aspirational sold as shipped) — the credibility gaps

Ranked by risk:

1. **Cue Halo wearable — hardware pre-sale.** The site runs a "Reserve your Halo" founders pre-sale for a "featherweight wearable with a multi-dimensional mic array." There is no hardware. **Taking pre-orders/payment for unbuilt hardware is the single biggest trust + (potentially) consumer-protection risk on the site.** Recommend: reframe as "Join the Halo waitlist — in development, no payment," or pull it to a clearly-labeled concept/roadmap page until it's real.

2. **"Cue Live lives on your screen — follows your cursor, sees what you see, Take Control."** The screen-aware desktop presence + Take-Control autonomy is **not shipped** (the native macOS screen-capture / VAD / take-control lift is still on the backlog). Today "Cue Live" = a working voice surface + a control-panel design. Selling ambient screen-watching + "it drives your apps" as present will disappoint. Reframe as roadmap / early-access.

3. **Agent Network / A2A (OpenClaw, Hermes, "teams up with other people's agents").** Not verified functional; reads aspirational. Mark as "coming" or remove until demoable.

4. **Skills count mismatch.** Home says **"85 skills / 85 indexed capabilities"**; the live instance reports **44**. Pick the true number and use it everywhere (a wrong, precise number erodes trust more than a rounded one).

5. **Model choice ("Claude Sonnet 4, GPT-4o, Gemini, or local").** Today the brain runs **Gemini** (the other routes are currently blocked on the shared key). Either broaden routing before claiming it, or soften to "runs on frontier models (Gemini today; Claude/OpenAI/local configurable)."

6. **Web research / "pulls the numbers."** `web_search` has **no backend on self-host** (needs a Brave/Tavily key; the managed proxy isn't reachable). Autonomy demos that imply live web research (e.g. "Acme renewal — pulls numbers") over-promise until a search key is wired. Quick real fix: add a Brave/Tavily key.

7. **Polished autonomy vignettes** ("16 minutes… books the call," reservation booking). The *loop* is real; these specific end-to-end flows are idealized. Keep them but label as illustrative, or record one true run as proof.

---

## C. What's missing from the site that we should build/tell

- **Proof over promises.** The strongest asset Cue has is *real, running autonomy* — show an actual mission run stream / work-item review, a real memory card with provenance, a real agent spend ledger. Screens of true product beat rendered vignettes.
- **The self-host / privacy story as a pillar**, not a footnote — this is a genuine moat vs. every cloud-only assistant.
- **A concrete "day with Cue"** narrative tied to the real surfaces (HQ → needs-you → approve → done), which matches what actually ships.
- **Honest status taxonomy**: a simple, consistent "Shipping / Early access / On the roadmap" chip system so excitement and honesty coexist.

---

## D. Claude Design brief — justcue.ai + product.html

**Goal:** keep the ambition and the beautiful voice/vision story, but re-anchor the site on what's *verifiably shipping* so the promise and the product match — turning "principled" from a tagline into the site's structure. Increase sell-through by leading with proof, not by widening claims.

**Deliverables**
1. **Honesty/status pass across both pages.** Introduce a lightweight, on-brand status chip (Shipping · Early access · Roadmap). Apply to every feature block. Nothing labeled "Already shipping" that isn't.
2. **Re-sequence the homepage** to lead with the 3–4 verified pillars: (a) *It runs while you sleep* (autonomy loop — real), (b) *One memory, with receipts* (provenance memory — real + differentiating), (c) *Talk to it* (voice — real, now with the new orb), (d) *Your cloud, your keys* (trust/self-host — real moat). Move Halo, screen-aware Take Control, and A2A into a clearly-marked "What's next" section.
3. **Halo treatment:** redesign from "Reserve/pre-sale" to "Waitlist / in development" (no payment) unless hardware + fulfilment are real. Flag legal review.
4. **Fix the factual specifics:** skills count (use the true number), model list, and any capability implied by web research until a search provider is wired.
5. **Add a "Proof" strip:** real product screenshots (mission run, needs-you queue, memory card w/ confidence, agent ledger, the voice orb) — replace/supplement rendered vignettes with true UI.
6. **product.html:** keep the excellent feature taxonomy (Missions, Create Studio, Voice, People, Omni-channel, Agents, Platform) — it closely matches reality — but apply the same status chips; soften the omni-channel "screen/wearable" capture claims (screen capture + Halo not shipped) to roadmap.
7. **Preserve** the voice, tone, typography, and the strong lines ("Stop always wins," "your cloud · your keys," "It already knows your next move"). This is a *trust-alignment + resequencing* pass, not a rebrand.

**Guardrail for the designer:** the differentiator is principled capability. Every claim should be one a new user will actually experience in their first session on `manav.justcue.app` today, or be visibly marked as coming. That single rule resolves ~all the gaps above.

---

## E. One quick engineering fix that closes a gap
Add a **Brave or Tavily API key** → `web_search` starts working on self-host (currently the only broken tool in the QA sweep), which also makes the "pulls the numbers / research" autonomy claims true.
