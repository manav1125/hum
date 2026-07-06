// cue-sizzle.jsx — Cue sizzle reel scene (uses globals from animations.jsx)
(function () {
  const { Stage, Sprite, TextSprite, ImageSprite, useSprite, Easing, animate, interpolate } = window;
  const R = React;

  const BLUE = "#3D6EE8", LAV = "#9DB4E6", INK = "#0F1620", MONO = "'DM Mono',monospace", SANS = "'DM Sans',system-ui,sans-serif";

  // typing text driven by sprite-local time
  function Typer({ text, x, y, size, delay = 0, cps = 22 }) {
    const { localTime } = useSprite();
    const n = Math.max(0, Math.floor((localTime - delay) * cps));
    const shown = text.slice(0, n);
    const caretOn = Math.floor(localTime * 2) % 2 === 0;
    return R.createElement("div", { style: { position: "absolute", left: x, top: y, fontFamily: SANS, fontSize: size, color: "#E6ECF5", whiteSpace: "pre" } },
      shown,
      R.createElement("span", { style: { display: "inline-block", width: size * .5, height: size * 1.05, background: BLUE, borderRadius: 2, verticalAlign: "-12%", marginLeft: 4, opacity: caretOn ? 1 : 0 } })
    );
  }

  function Kicker({ text, x, y, color = LAV, size = 26 }) {
    const { localTime } = useSprite();
    const o = animate({ from: 0, to: 1, start: 0, end: .6, ease: Easing.easeOutCubic })(localTime);
    return R.createElement("div", { style: { position: "absolute", left: x, top: y, fontFamily: MONO, fontSize: size, letterSpacing: ".18em", color, opacity: o } }, text);
  }

  function FanCard({ x, y, tag, tagColor, title, body, delay }) {
    const { localTime } = useSprite();
    const t = Math.max(0, localTime - delay);
    const o = animate({ from: 0, to: 1, start: 0, end: .5, ease: Easing.easeOutCubic })(t);
    const ty = animate({ from: 26, to: 0, start: 0, end: .5, ease: Easing.easeOutCubic })(t);
    return R.createElement("div", { style: { position: "absolute", left: x, top: y, width: 380, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 18, padding: "26px 28px", opacity: o, transform: `translateY(${ty}px)`, fontFamily: SANS } },
      R.createElement("div", { style: { fontFamily: MONO, fontSize: 15, letterSpacing: ".12em", color: tagColor, marginBottom: 12 } }, tag),
      R.createElement("div", { style: { fontSize: 24, fontWeight: 600, color: "#fff", letterSpacing: "-.4px" } }, title),
      R.createElement("div", { style: { fontSize: 17, color: "#AEB7C7", marginTop: 8, lineHeight: 1.5 } }, body)
    );
  }

  // full-bleed screenshot scene with caption bar
  function Shot({ src, kicker, title, offsetY = 0, w = "88%" }) {
    const { localTime, duration } = useSprite();
    const scale = animate({ from: 1.04, to: 1.12, start: 0, end: duration, ease: Easing.linear })(localTime);
    const oIn = animate({ from: 0, to: 1, start: 0, end: .6, ease: Easing.easeOutCubic })(localTime);
    const oOut = animate({ from: 1, to: 0, start: duration - .5, end: duration, ease: Easing.easeInCubic })(localTime);
    const o = Math.min(oIn, oOut);
    return R.createElement("div", { style: { position: "absolute", inset: 0, opacity: o } },
      R.createElement("div", { style: { position: "absolute", inset: 0, overflow: "hidden" } },
        R.createElement("img", { src, style: { position: "absolute", left: "50%", top: "50%", width: w, transform: `translate(-50%,${-50 + offsetY}%) scale(${scale})`, borderRadius: 18, border: "1px solid rgba(255,255,255,.15)", boxShadow: "0 60px 140px -40px rgba(0,0,0,.85)" } })
      ),
      R.createElement("div", { style: { position: "absolute", left: 0, right: 0, bottom: 0, height: 300, background: "linear-gradient(transparent,rgba(11,17,26,.96) 65%)" } }),
      R.createElement("div", { style: { position: "absolute", left: 90, bottom: 96, fontFamily: MONO, fontSize: 22, letterSpacing: ".16em", color: LAV } }, kicker),
      R.createElement("div", { style: { position: "absolute", left: 88, bottom: 26, fontFamily: SANS, fontSize: 52, fontWeight: 600, letterSpacing: "-1.5px", color: "#fff" } }, title)
    );
  }

  function BigLine({ lines, y = 400, size = 110 }) {
    const { localTime } = useSprite();
    return R.createElement("div", { style: { position: "absolute", left: 0, right: 0, top: y, textAlign: "center", fontFamily: SANS } },
      lines.map((l, i) => {
        const t = Math.max(0, localTime - i * .35);
        const o = animate({ from: 0, to: 1, start: 0, end: .6, ease: Easing.easeOutCubic })(t);
        const ty = animate({ from: 40, to: 0, start: 0, end: .6, ease: Easing.easeOutQuart })(t);
        return R.createElement("div", { key: i, style: { fontSize: size, fontWeight: l.bold ? 600 : 500, letterSpacing: "-4px", lineHeight: 1.04, color: l.color || "#fff", opacity: o, transform: `translateY(${ty}px)` } }, l.text);
      })
    );
  }

  function Logo({ x, y, s = 1 }) {
    return R.createElement("div", { style: { position: "absolute", left: x, top: y, display: "flex", alignItems: "center", gap: 14 * s, transform: `scale(1)` } },
      R.createElement("div", { style: { width: 64 * s, height: 64 * s, borderRadius: 18 * s, background: "#1A2230", border: "2px solid rgba(255,255,255,.2)", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" } },
        R.createElement("span", { style: { fontFamily: SANS, fontSize: 38 * s, fontWeight: 600, color: "#fff" } }, "C"),
        R.createElement("span", { style: { position: "absolute", width: 10 * s, height: 10 * s, borderRadius: "50%", background: BLUE, right: 12 * s, bottom: 15 * s } })
      ),
      R.createElement("span", { style: { fontFamily: SANS, fontSize: 46 * s, fontWeight: 500, letterSpacing: -2 * s, color: "#fff" } }, "cue", R.createElement("span", { style: { color: BLUE } }, "."))
    );
  }

  function Vignette() {
    return R.createElement("div", { style: { position: "absolute", inset: 0, background: "radial-gradient(90% 120% at 50% -20%,rgba(61,110,232,.22),transparent 60%)", pointerEvents: "none" } });
  }

  window.CueSizzle = function CueSizzle() {
    return R.createElement(Stage, { width: 1920, height: 1080, duration: 66, background: INK, loop: true },
      R.createElement(Vignette),

      // S1 · 0–6 open
      R.createElement(Sprite, { start: 0, end: 6 },
        R.createElement(Logo, { x: 830, y: 300 }),
        R.createElement(BigLine, { lines: [{ text: "It already knows" }, { text: "your next move.", color: LAV, bold: true }], y: 460, size: 104 })
      ),

      // S2 · 6–14 the ask
      R.createElement(Sprite, { start: 6, end: 14 },
        R.createElement(Kicker, { text: "THE ASK", x: 90, y: 120 }),
        R.createElement("div", { style: { position: "absolute", left: 90, top: 190, width: 1300, height: 110, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.16)", borderRadius: 24 } }),
        R.createElement(Typer, { text: "Prep everything for Thursday's board meeting", x: 130, y: 218, size: 42, delay: .4 }),
        R.createElement(FanCard, { x: 90, y: 420, tag: "MISSIONS", tagColor: LAV, title: "Mission spun up", body: "3 agents assigned · metrics pulled from Stripe + Sheets", delay: 3.0 }),
        R.createElement(FanCard, { x: 530, y: 420, tag: "CREATE STUDIO", tagColor: "#C9B8FF", title: "Deck drafted", body: "14 slides · on-brand · 3 variants ready to review", delay: 3.7 }),
        R.createElement(FanCard, { x: 970, y: 420, tag: "VOICE + MEETINGS", tagColor: "#8FD3B6", title: "Pre-reads captured", body: "Last board call summarized · questions threaded", delay: 4.4 }),
        R.createElement(FanCard, { x: 1410, y: 420, tag: "GUARDRAILS", tagColor: LAV, title: "2 approvals waiting", body: "Nothing moves without you", delay: 5.1 })
      ),

      // S3–S7 · product shots
      R.createElement(Sprite, { start: 14, end: 24 }, R.createElement(Shot, { src: "screenshots/prod-hq-dark.png", kicker: "MISSIONS — YOUR WORK OS", title: "Goals in. Shipped work out." })),
      R.createElement(Sprite, { start: 24, end: 33 }, R.createElement(Shot, { src: "screenshots/prod-agents.png", kicker: "AGENTS — YOUR AI ORG", title: "Not one model. A workforce." })),
      R.createElement(Sprite, { start: 33, end: 42 }, R.createElement(Shot, { src: "screenshots/prod-create.png", kicker: "CREATE STUDIO + BRAND KIT", title: "Work that looks like you made it." })),
      R.createElement(Sprite, { start: 42, end: 51 }, R.createElement(Shot, { src: "screenshots/prod-guardrails.png", kicker: "GUARDRAILS", title: "It acts alone. Only inside your rules." })),
      R.createElement(Sprite, { start: 51, end: 59 }, R.createElement(Shot, { src: "screenshots/prod-phone-dark.png", kicker: "EVERYWHERE", title: "Approve from your phone.", offsetY: 0, w: "26%" })),

      // S8 · close
      R.createElement(Sprite, { start: 59, end: 66 },
        R.createElement(BigLine, { lines: [{ text: "Your work is already" }, { text: "in motion.", color: LAV, bold: true }], y: 330, size: 120 }),
        R.createElement(Logo, { x: 855, y: 700 }),
        R.createElement("div", { style: { position: "absolute", left: 0, right: 0, top: 830, textAlign: "center", fontFamily: MONO, fontSize: 24, letterSpacing: ".2em", color: "#7E8BA3" } }, "CUE.AI · SHIPPING NOW")
      )
    );
  };
})();
