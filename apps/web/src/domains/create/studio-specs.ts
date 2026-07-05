/**
 * Create Studio — Template & Style registries (Layer 1 of the Create Studio direction).
 *
 * See docs/cue-create-studio-direction.md. This file is PURE DATA + TYPES. It has
 * no runtime dependency on generation, routing, or UI. Consumers (a gallery
 * overlay + a skill-side contract loader, both owned by other workstreams) resolve
 * a `TemplateSpec` / `StyleSpec` by id and either:
 *   - inject the palette/fonts/layout as a pinned design contract into `app-builder`
 *     (Tier-1 "design-contract" — renders the user's real content in this look), or
 *   - (Tier-2, later) fill the real HTML skeleton in `sourceHtmlDir` for pixel-faithful
 *     reproduction. The staged HTML lives in the app-builder skill under
 *     templates/presentations/<sourceHtmlDir>/ (see references/TEMPLATES.md there).
 *
 * Every TemplateSpec below was DERIVED from the Mira fork's real slide HTML:
 * the palettes are the actual dominant hex colors pulled from each deck, the fonts
 * are the real Google Font families each template loads, and layoutRhythm /
 * coverTreatment describe the observed slide structure. These are faithful captures
 * of real design systems, not invented themes.
 *
 * Thumbnails were lifted from Mira into apps/web/public/images/create-studio/.
 * Paths are stored root-relative; pass them through `publicAsset()` when rendering
 * (see apps/web/src/utils/public-asset.ts) so Vite's `base` is respected.
 */

/** How closely a template can be reproduced. */
export type TemplateFidelity = "both" | "contract" | "exact";

/** A named color role in a template's palette. All values are hex strings. */
export interface TemplatePalette {
  /** Dominant brand color — headlines, key accents, cover fills. */
  primary: string;
  /** Secondary highlight — used for emphasis, links, chart pops. */
  accent: string;
  /** Page / slide background. */
  bg: string;
  /** Raised surface (cards, panels) against the background. */
  surface: string;
  /** Primary body text color. */
  text: string;
  /** Muted / secondary text (captions, labels). */
  muted?: string;
}

export interface TemplateFonts {
  /** Display / heading family (as CSS font-family, primary name first). */
  heading: string;
  /** Body / paragraph family. */
  body: string;
}

export interface TemplateSpec {
  /** Stable id used in CreateIntent.templateId and to resolve the HTML dir. */
  id: string;
  /** Human-facing name shown in the gallery. */
  name: string;
  /** Root-relative thumbnail path (pass through publicAsset()). */
  thumbnail: string;
  /** Grouping for gallery tabs. */
  category:
    | "startup"
    | "editorial"
    | "minimal"
    | "bold"
    | "data"
    | "creative";
  /** Derived color roles. */
  palette: TemplatePalette;
  /** Derived type pairing. */
  fonts: TemplateFonts;
  /**
   * The observed slide-to-slide layout pattern — an ordered vocabulary the
   * contract generator can cycle through so generated decks feel authored, not
   * uniform. Faithful to how the source deck sequences its slides.
   */
  layoutRhythm: string[];
  /** How the cover / title slide is treated. */
  coverTreatment: string;
  /** Achievable fidelity tiers for this template. */
  fidelity: TemplateFidelity;
  /**
   * Folder name under the app-builder skill's templates/presentations/ where the
   * real slide_NN.html + metadata.json are staged (Tier-2 pixel-faithful source).
   */
  sourceHtmlDir?: string;
  /** One-line "reach for this when…" guidance for the picker + auto-defaults. */
  bestFor: string;
}

const TEMPLATE_THUMB = (file: string) =>
  `/images/create-studio/templates/${file}`;

/**
 * 18 deck TemplateSpecs, palettes/fonts/layout derived from
 * backend/core/templates/presentations/<dir>/slide_*.html in the Mira fork.
 */
export const TEMPLATE_SPECS: TemplateSpec[] = [
  {
    id: "startup",
    name: "Startup",
    thumbnail: TEMPLATE_THUMB("startup-min.png"),
    category: "startup",
    palette: {
      primary: "#0066ff",
      accent: "#3d85ff",
      bg: "#ffffff",
      surface: "#f5f5f5",
      text: "#0a0a0a",
      muted: "#a3a3a3",
    },
    fonts: {
      heading: "'Inter', -apple-system, sans-serif",
      body: "'Inter', -apple-system, sans-serif",
    },
    layoutRhythm: [
      "oversized-uppercase-cover",
      "gradient-bar-hero",
      "metric-grid",
      "two-column-feature",
      "device-mockup-showcase",
      "full-bleed-cta",
    ],
    coverTreatment:
      "140px uppercase Inter headline with 8px tracking over a white field, animated electric-blue gradient bars anchoring the lower edge",
    fidelity: "both",
    sourceHtmlDir: "startup",
    bestFor: "SaaS / venture pitch decks with a confident, product-forward tone",
  },
  {
    id: "elevator_pitch",
    name: "Elevator Pitch",
    thumbnail: TEMPLATE_THUMB("elevator_pitch-min.png"),
    category: "startup",
    palette: {
      primary: "#7c3aed",
      accent: "#6ee7b7",
      bg: "#fafafa",
      surface: "#ffffff",
      text: "#000000",
      muted: "#6b7280",
    },
    fonts: {
      heading: "'Inter', -apple-system, sans-serif",
      body: "'Inter', -apple-system, sans-serif",
    },
    layoutRhythm: [
      "geometric-logo-cover",
      "purple-shape-statement",
      "mint-accent-column",
      "big-number-callout",
      "three-column-grid",
      "closing-contact",
    ],
    coverTreatment:
      "140px tight-tracked Inter title with a stacked bar logo, violet top shape and a trio of accent columns rising from the bottom edge",
    fidelity: "both",
    sourceHtmlDir: "elevator_pitch",
    bestFor: "Short, punchy fundraise pitches — violet + mint, high energy",
  },
  {
    id: "minimalist",
    name: "Minimalist",
    thumbnail: TEMPLATE_THUMB("minimalist-min.png"),
    category: "minimal",
    palette: {
      primary: "#2c3e50",
      accent: "#e67e22",
      bg: "#ffffff",
      surface: "#f5f1ed",
      text: "#2c3e50",
      muted: "#7f8c8d",
    },
    fonts: {
      heading: "'Playfair Display', Georgia, serif",
      body: "'Lora', Georgia, serif",
    },
    layoutRhythm: [
      "split-image-title",
      "serif-statement",
      "editorial-two-column",
      "full-image-caption",
      "quote-slide",
      "restrained-closing",
    ],
    coverTreatment:
      "Left text column with a 180px Playfair title and small tracked label, paired with a full-height image panel on the right; slate-and-cream palette",
    fidelity: "both",
    sourceHtmlDir: "minimalist",
    bestFor: "Elegant editorial decks, brand stories, considered proposals",
  },
  {
    id: "minimalist_2",
    name: "Minimalist Blue",
    thumbnail: TEMPLATE_THUMB("minimalist_2-min.png"),
    category: "minimal",
    palette: {
      primary: "#1a1a1a",
      accent: "#8fa5c7",
      bg: "#f5f5f5",
      surface: "#ffffff",
      text: "#1a1a1a",
      muted: "#666666",
    },
    fonts: {
      heading: "'Work Sans', -apple-system, sans-serif",
      body: "'Work Sans', -apple-system, sans-serif",
    },
    layoutRhythm: [
      "airy-title",
      "dusty-blue-accent-block",
      "generous-whitespace-list",
      "two-column-text",
      "muted-image-feature",
      "quiet-closing",
    ],
    coverTreatment:
      "Light-grey field with black Work Sans title and a soft dusty-blue accent block; lots of negative space",
    fidelity: "both",
    sourceHtmlDir: "minimalist_2",
    bestFor: "Calm, modern corporate decks with a soft dusty-blue accent",
  },
  {
    id: "premium_black",
    name: "Premium Black",
    thumbnail: TEMPLATE_THUMB("premium_black-min.png"),
    category: "bold",
    palette: {
      primary: "#ffffff",
      accent: "#888888",
      bg: "#000000",
      surface: "#111111",
      text: "#ffffff",
      muted: "#888888",
    },
    fonts: {
      heading: "'Poppins', sans-serif",
      body: "'Poppins', sans-serif",
    },
    layoutRhythm: [
      "centered-white-on-black-cover",
      "high-contrast-statement",
      "single-focal-image",
      "restrained-metric",
      "luxury-two-column",
      "monochrome-closing",
    ],
    coverTreatment:
      "Pure black field with centered white Poppins title, grey supporting line; maximal contrast, luxury restraint",
    fidelity: "both",
    sourceHtmlDir: "premium_black",
    bestFor: "Luxury / premium brands, high-end product and agency decks",
  },
  {
    id: "premium_green",
    name: "Premium Green",
    thumbnail: TEMPLATE_THUMB("premium_green-min.png"),
    category: "editorial",
    palette: {
      primary: "#9b9886",
      accent: "#d0ffcd",
      bg: "#f5f3ee",
      surface: "#e8e6e1",
      text: "#2b2b2b",
      muted: "#9b9886",
    },
    fonts: {
      heading: "'Gupter', 'Libre Baskerville', serif",
      body: "'Inter', sans-serif",
    },
    layoutRhythm: [
      "serif-editorial-cover",
      "sage-block-statement",
      "baskerville-pullquote",
      "two-column-serif-body",
      "mint-highlight-feature",
      "understated-closing",
    ],
    coverTreatment:
      "Warm sage-and-stone field with a Gupter/Baskerville serif title and pale-mint highlight accents; editorial, tactile",
    fidelity: "both",
    sourceHtmlDir: "premium_green",
    bestFor: "Refined, organic brand decks — wellness, design, sustainability",
  },
  {
    id: "architect",
    name: "Architect",
    thumbnail: TEMPLATE_THUMB("architect-min.png"),
    category: "editorial",
    palette: {
      primary: "#ff6b35",
      accent: "#9ba5b7",
      bg: "#f5f3ee",
      surface: "#ffffff",
      text: "#2b2b2b",
      muted: "#b8c1d0",
    },
    fonts: {
      heading: "'Inter', -apple-system, sans-serif",
      body: "'Inter', -apple-system, sans-serif",
    },
    layoutRhythm: [
      "gridline-cover",
      "blueprint-diagram",
      "orange-accent-statement",
      "spec-two-column",
      "full-bleed-project-image",
      "credits-closing",
    ],
    coverTreatment:
      "Warm off-white field with a slate-blue gradient panel and a burnt-orange accent; structured, gridded, blueprint feel",
    fidelity: "both",
    sourceHtmlDir: "architect",
    bestFor: "Architecture, construction, design-studio and portfolio decks",
  },
  {
    id: "portfolio",
    name: "Portfolio",
    thumbnail: TEMPLATE_THUMB("portfolio-min.png"),
    category: "creative",
    palette: {
      primary: "#000000",
      accent: "#813648",
      bg: "#ffffff",
      surface: "#f5f5f5",
      text: "#000000",
      muted: "#666666",
    },
    fonts: {
      heading: "'Rubik', sans-serif",
      body: "'Rubik', sans-serif",
    },
    layoutRhythm: [
      "bold-name-cover",
      "work-grid",
      "case-study-two-column",
      "full-bleed-project",
      "wine-accent-statement",
      "contact-closing",
    ],
    coverTreatment:
      "Clean white field with heavy black Rubik name/title and a muted wine accent; gallery-grid personality",
    fidelity: "both",
    sourceHtmlDir: "portfolio",
    bestFor: "Personal / studio portfolios and case-study showcases",
  },
  {
    id: "professor_gray",
    name: "Professor",
    thumbnail: TEMPLATE_THUMB("professor_gray-min.png"),
    category: "editorial",
    palette: {
      primary: "#383838",
      accent: "#acde70",
      bg: "#ffffff",
      surface: "#f5f5f5",
      text: "#383838",
      muted: "#e0e0e0",
    },
    fonts: {
      heading: "'Playfair Display', serif",
      body: "'Playfair Display', serif",
    },
    layoutRhythm: [
      "academic-title",
      "playfair-thesis-statement",
      "lecture-two-column",
      "highlighted-key-term",
      "diagram-slide",
      "references-closing",
    ],
    coverTreatment:
      "White field with charcoal Playfair title, lime and pink pop accents used sparingly; lecture / academic tone",
    fidelity: "both",
    sourceHtmlDir: "professor_gray",
    bestFor: "Lectures, research readouts, educational and thesis decks",
  },
  {
    id: "textbook",
    name: "Textbook",
    thumbnail: TEMPLATE_THUMB("textbook-min.png"),
    category: "creative",
    palette: {
      primary: "#000000",
      accent: "#ff6a3b",
      bg: "#ded8cb",
      surface: "#ffffff",
      text: "#0a0a0a",
      muted: "#5fa8a3",
    },
    fonts: {
      heading: "'Staatliches', 'Zilla Slab', serif",
      body: "'Inter', sans-serif",
    },
    layoutRhythm: [
      "stacked-condensed-cover",
      "chapter-divider",
      "annotated-diagram",
      "retro-two-column",
      "call-out-card",
      "index-closing",
    ],
    coverTreatment:
      "Warm paper (kraft) card with a 220px stacked Staatliches condensed title and orange/teal retro accents; vintage textbook feel",
    fidelity: "both",
    sourceHtmlDir: "textbook",
    bestFor: "Playful, retro-editorial explainers and zine-style decks",
  },
  {
    id: "hipster",
    name: "Hipster",
    thumbnail: TEMPLATE_THUMB("hipster-min.png"),
    category: "bold",
    palette: {
      primary: "#b5ff81",
      accent: "#516b38",
      bg: "#000000",
      surface: "#111111",
      text: "#ffffff",
      muted: "#e8e8e8",
    },
    fonts: {
      heading: "'Averia Serif Libre', serif",
      body: "'Arial', sans-serif",
    },
    layoutRhythm: [
      "giant-type-cover",
      "tag-row-statement",
      "lime-on-black-feature",
      "editorial-image-block",
      "oversized-quote",
      "brand-closing",
    ],
    coverTreatment:
      "Black field with a 350px uppercase title, an Averia serif subtitle and pill tags; acid-lime on black, streetwear energy",
    fidelity: "both",
    sourceHtmlDir: "hipster",
    bestFor: "Bold lifestyle / fashion / creative brand decks with attitude",
  },
  {
    id: "colorful",
    name: "Colorful",
    thumbnail: TEMPLATE_THUMB("colorful-min.png"),
    category: "creative",
    palette: {
      primary: "#136f64",
      accent: "#ff4617",
      bg: "#ffffff",
      surface: "#fbe4ca",
      text: "#1a1a1a",
      muted: "#c2f3d9",
    },
    fonts: {
      heading: "'DM Serif Display', serif",
      body: "'Inter', sans-serif",
    },
    layoutRhythm: [
      "serif-display-cover",
      "color-block-statement",
      "teal-and-coral-feature",
      "two-column-mixed-type",
      "swatch-callout",
      "vibrant-closing",
    ],
    coverTreatment:
      "White field with a large DM Serif Display title, deep-teal and coral color blocks and warm cream panels; expressive and warm",
    fidelity: "both",
    sourceHtmlDir: "colorful",
    bestFor: "Vibrant, expressive brand and campaign decks",
  },
  {
    id: "green",
    name: "Forest Green",
    thumbnail: TEMPLATE_THUMB("green-min.png"),
    category: "editorial",
    palette: {
      primary: "#2d5f3f",
      accent: "#1a4d2e",
      bg: "#f8f9fa",
      surface: "#ffffff",
      text: "#1a1a1a",
      muted: "#d0d0d0",
    },
    fonts: {
      heading: "'Space Grotesk', sans-serif",
      body: "'Space Grotesk', sans-serif",
    },
    layoutRhythm: [
      "gradient-forest-cover",
      "deep-green-statement",
      "grotesk-two-column",
      "metric-band",
      "full-image-feature",
      "grounded-closing",
    ],
    coverTreatment:
      "Deep forest gradient (dark to mid green) with light Space Grotesk title on an airy off-white base; natural, grounded",
    fidelity: "both",
    sourceHtmlDir: "green",
    bestFor: "Sustainability, nature, ESG and calm corporate decks",
  },
  {
    id: "black_and_white_clean",
    name: "Black & White Clean",
    thumbnail: TEMPLATE_THUMB("black_and_white_clean-min.png"),
    category: "minimal",
    palette: {
      primary: "#1a1a1a",
      accent: "#6ee7b7",
      bg: "#ffffff",
      surface: "#f5f5f5",
      text: "#1a1a1a",
      muted: "#999999",
    },
    fonts: {
      heading: "'Inter', sans-serif",
      body: "'Inter', sans-serif",
    },
    layoutRhythm: [
      "clean-title",
      "monochrome-statement",
      "mint-gradient-accent",
      "structured-two-column",
      "data-callout",
      "minimal-closing",
    ],
    coverTreatment:
      "Crisp white/near-black field with Inter title and an occasional mint gradient sliver; clean, neutral, versatile",
    fidelity: "both",
    sourceHtmlDir: "black_and_white_clean",
    bestFor: "Neutral, all-purpose corporate decks that let content lead",
  },
  {
    id: "gamer_gray",
    name: "Gamer",
    thumbnail: TEMPLATE_THUMB("gamer_gray-min.png"),
    category: "bold",
    palette: {
      primary: "#68d391",
      accent: "#63b3ed",
      bg: "#000000",
      surface: "#1a202c",
      text: "#e2e8f0",
      muted: "#cfcfcf",
    },
    fonts: {
      heading: "'Jersey 15', 'Unbounded', sans-serif",
      body: "'Instrument Sans', sans-serif",
    },
    layoutRhythm: [
      "terminal-window-cover",
      "pixel-heading-statement",
      "hud-metric-grid",
      "mono-code-callout",
      "screenshot-feature",
      "traffic-light-closing",
    ],
    coverTreatment:
      "Dark UI with a mac-style traffic-light window chrome, pixel/arcade Jersey heading and green/blue HUD accents; gamer / dev aesthetic",
    fidelity: "both",
    sourceHtmlDir: "gamer_gray",
    bestFor: "Gaming, dev-tool and hacker-culture product decks",
  },
  {
    id: "numbers_clean",
    name: "Numbers Clean",
    thumbnail: TEMPLATE_THUMB("numbers_clean-min.png"),
    category: "data",
    palette: {
      primary: "#e63946",
      accent: "#2b2b2b",
      bg: "#e8e8e8",
      surface: "#ffffff",
      text: "#000000",
      muted: "#4a4a4a",
    },
    fonts: {
      heading: "'Inter', sans-serif",
      body: "'Inter', sans-serif",
    },
    layoutRhythm: [
      "big-stat-cover",
      "kpi-grid",
      "single-metric-hero",
      "comparison-bars",
      "trend-callout",
      "summary-closing",
    ],
    coverTreatment:
      "Light-grey gradient field with an oversized headline number and a single red accent; data-first, restrained",
    fidelity: "both",
    sourceHtmlDir: "numbers_clean",
    bestFor: "Metric-heavy readouts, financials and KPI reviews (clean)",
  },
  {
    id: "numbers_colorful",
    name: "Numbers Colorful",
    thumbnail: TEMPLATE_THUMB("numbers_colorful-min.png"),
    category: "data",
    palette: {
      primary: "#13ea94",
      accent: "#a391ff",
      bg: "#dfdfdf",
      surface: "#ffffff",
      text: "#1a1a1a",
      muted: "#ffcd6c",
    },
    fonts: {
      heading: "'Inter', sans-serif",
      body: "'Inter', sans-serif",
    },
    layoutRhythm: [
      "vibrant-stat-cover",
      "color-coded-kpi-grid",
      "gauge-metric",
      "stacked-comparison",
      "highlight-trend",
      "colorful-summary",
    ],
    coverTreatment:
      "Soft-grey field with big numbers coded in green / lavender / amber pastels; energetic data storytelling",
    fidelity: "both",
    sourceHtmlDir: "numbers_colorful",
    bestFor: "Dashboards and metric decks that need a friendly, colorful pop",
  },
  {
    id: "competitor_analysis_blue",
    name: "Competitor Analysis",
    thumbnail: TEMPLATE_THUMB("competitor_analysis_blue-min.png"),
    category: "data",
    palette: {
      primary: "#536cf8",
      accent: "#ffd93d",
      bg: "#ffffff",
      surface: "#f0f2ff",
      text: "#1a1a1a",
      muted: "#8a94b8",
    },
    fonts: {
      heading: "'Lilita One', cursive",
      body: "'Arial', sans-serif",
    },
    layoutRhythm: [
      "poster-title-cover",
      "matrix-2x2",
      "competitor-comparison-table",
      "feature-checklist",
      "positioning-quadrant",
      "takeaway-closing",
    ],
    coverTreatment:
      "Electric-blue field with a 250px rounded Lilita One poster title, star decorations and a yellow pop; loud, comparison-led",
    fidelity: "both",
    sourceHtmlDir: "competitor_analysis_blue",
    bestFor: "Competitive landscapes, positioning matrices, market maps",
  },
];

/** Lookup a TemplateSpec by id. */
export function getTemplateSpec(id: string): TemplateSpec | undefined {
  return TEMPLATE_SPECS.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// StyleSpecs — image (15) + video (6). Selection appends `promptFragment` to
// the image / replicate prompt (see the direction doc, Layer 1 · StyleSpec).
// ---------------------------------------------------------------------------

export type StyleKind = "image" | "video";

/**
 * Video style sub-grouping — powers the "All 6 / Live-action / Animated" tabs
 * in the Video gallery variant. Live-action styles read as captured footage;
 * animated styles read as rendered / illustrated motion. Only set on video
 * specs; image specs leave it undefined.
 */
export type VideoStyleKind = "live" | "animated";

export interface StyleSpec {
  /** Stable id used in CreateIntent.styleId. */
  id: string;
  /** Human-facing label shown in the gallery. */
  label: string;
  /** image | video — which mode's gallery this belongs to. */
  kind: StyleKind;
  /** Root-relative thumbnail path (pass through publicAsset()). */
  thumbnail: string;
  /** Appended to the generation prompt to steer the look. */
  promptFragment: string;
  /** Optional model hint (a Replicate slug or family) the style suits best. */
  model?: string;
  /** Video-only: which "Live-action | Animated" tab this style belongs to. */
  videoKind?: VideoStyleKind;
}

const IMAGE_THUMB = (file: string) =>
  `/images/create-studio/image-styles/${file}`;
const VIDEO_THUMB = (file: string) =>
  `/images/create-studio/video-styles/${file}`;

/** 15 image StyleSpecs. */
export const IMAGE_STYLE_SPECS: StyleSpec[] = [
  {
    id: "isometric",
    label: "Isometric 3D",
    kind: "image",
    thumbnail: IMAGE_THUMB("isometric_bedroom-min.png"),
    promptFragment:
      "isometric 3D illustration, clean vector shapes, soft studio lighting, 45-degree axonometric angle, subtle ambient occlusion, muted pastel palette",
  },
  {
    id: "photorealistic",
    label: "Photorealistic",
    kind: "image",
    thumbnail: IMAGE_THUMB("photorealistic_eagle-min.png"),
    promptFragment:
      "photorealistic, ultra-detailed, natural lighting, shallow depth of field, 50mm lens, high dynamic range, sharp focus, lifelike textures",
  },
  {
    id: "watercolor",
    label: "Watercolor",
    kind: "image",
    thumbnail: IMAGE_THUMB("watercolor_garden-min.png"),
    promptFragment:
      "delicate watercolor painting, soft bleeding washes, visible paper texture, loose organic brushwork, gentle pastel pigments, hand-painted feel",
  },
  {
    id: "oil_painting",
    label: "Oil Painting",
    kind: "image",
    thumbnail: IMAGE_THUMB("oil_painting_villa-min.png"),
    promptFragment:
      "classical oil painting, thick impasto brushstrokes, rich layered pigments, warm golden light, canvas texture, painterly old-master style",
  },
  {
    id: "impressionist",
    label: "Impressionist",
    kind: "image",
    thumbnail: IMAGE_THUMB("impressionist_garden-min.png"),
    promptFragment:
      "impressionist painting, dappled light, short visible brushstrokes, vibrant broken color, plein-air atmosphere, Monet-inspired softness",
  },
  {
    id: "anime",
    label: "Anime",
    kind: "image",
    thumbnail: IMAGE_THUMB("anime_forest-min.png"),
    promptFragment:
      "anime illustration, cel-shaded, clean line art, expressive eyes, vivid saturated colors, Studio Ghibli-inspired backgrounds, soft cinematic lighting",
  },
  {
    id: "comic_book",
    label: "Comic Book",
    kind: "image",
    thumbnail: IMAGE_THUMB("comic_book_robot-min.png"),
    promptFragment:
      "comic book art, bold ink outlines, halftone dot shading, dynamic action pose, saturated primary colors, pop-art panel energy",
  },
  {
    id: "digital_art_cyberpunk",
    label: "Cyberpunk",
    kind: "image",
    thumbnail: IMAGE_THUMB("digital_art_cyberpunk-min.png"),
    promptFragment:
      "cyberpunk digital art, neon-lit night city, rain-slick reflections, teal and magenta glow, holographic signage, high-contrast dramatic lighting",
  },
  {
    id: "neon",
    label: "Neon Glow",
    kind: "image",
    thumbnail: IMAGE_THUMB("neon_jellyfish-min.png"),
    promptFragment:
      "vivid neon glow, bioluminescent light, deep dark background, electric gradients, luminous rim lighting, dreamy iridescent color",
  },
  {
    id: "geometric",
    label: "Geometric",
    kind: "image",
    thumbnail: IMAGE_THUMB("geometric_crystal-min.png"),
    promptFragment:
      "low-poly geometric art, faceted crystalline forms, sharp angular planes, gradient facets, refracted light, clean modern 3D render",
  },
  {
    id: "abstract_organic",
    label: "Abstract Organic",
    kind: "image",
    thumbnail: IMAGE_THUMB("abstract_organic-min.png"),
    promptFragment:
      "abstract organic shapes, flowing fluid forms, smooth gradients, soft matte finish, sculptural blobs, calm minimalist composition",
  },
  {
    id: "surreal",
    label: "Surreal",
    kind: "image",
    thumbnail: IMAGE_THUMB("surreal_islands-min.png"),
    promptFragment:
      "surreal dreamscape, floating impossible elements, cinematic scale, ethereal atmosphere, Dali-inspired composition, otherworldly lighting",
  },
  {
    id: "pastel",
    label: "Pastel Landscape",
    kind: "image",
    thumbnail: IMAGE_THUMB("pastel_landscape-min.png"),
    promptFragment:
      "soft pastel landscape, gentle gradient sky, muted candy colors, minimal flat shading, serene dreamy mood, airy negative space",
  },
  {
    id: "vintage",
    label: "Vintage",
    kind: "image",
    thumbnail: IMAGE_THUMB("vintage_diner-min.png"),
    promptFragment:
      "vintage retro aesthetic, faded film grain, warm nostalgic tones, 1950s Americana palette, aged print texture, kodachrome color",
  },
  {
    id: "minimalist_photo",
    label: "Minimalist",
    kind: "image",
    thumbnail: IMAGE_THUMB("minimalist_coffee-min.png"),
    promptFragment:
      "minimalist photography, single subject, generous negative space, soft even lighting, muted neutral palette, clean composition, calm and refined",
  },
];

/**
 * 6 video StyleSpecs. Ordered + grouped to the SET-4 mock: the Video gallery
 * shows "All 6 / Live-action / Animated" tabs, so each spec declares a
 * `videoKind` — Cinematic / Product / Nature / Adventure read as captured
 * footage ("live"); Animation / Abstract read as rendered motion ("animated").
 */
export const VIDEO_STYLE_SPECS: StyleSpec[] = [
  {
    id: "cinematic",
    label: "Cinematic",
    kind: "video",
    videoKind: "live",
    thumbnail: VIDEO_THUMB("cinematic.png"),
    promptFragment:
      "cinematic footage, anamorphic lens, shallow depth of field, dramatic film lighting, graded color, smooth dolly motion, 24fps film look",
  },
  {
    id: "product",
    label: "Product",
    kind: "video",
    videoKind: "live",
    thumbnail: VIDEO_THUMB("product.png"),
    promptFragment:
      "clean product showcase, seamless studio backdrop, soft key + rim lighting, slow rotating hero shots, crisp reflections, premium commercial polish",
  },
  {
    id: "animation",
    label: "Animation",
    kind: "video",
    videoKind: "animated",
    thumbnail: VIDEO_THUMB("animation.png"),
    promptFragment:
      "stylized 2D/3D animation, fluid motion, bold shapes, vibrant palette, expressive character movement, clean motion-graphics timing",
  },
  {
    id: "nature",
    label: "Nature",
    kind: "video",
    videoKind: "live",
    thumbnail: VIDEO_THUMB("nature.png"),
    promptFragment:
      "nature documentary footage, sweeping aerial and macro shots, golden-hour light, lush natural color, serene slow pacing, David Attenborough mood",
  },
  {
    id: "abstract",
    label: "Abstract",
    kind: "video",
    videoKind: "animated",
    thumbnail: VIDEO_THUMB("abstract.png"),
    promptFragment:
      "abstract motion, flowing fluid gradients, particle systems, hypnotic looping movement, luminous color transitions, dreamlike non-representational visuals",
  },
  {
    id: "adventure",
    label: "Adventure",
    kind: "video",
    videoKind: "live",
    thumbnail: VIDEO_THUMB("person.png"),
    promptFragment:
      "adventurous action footage, dynamic handheld and drone motion, wide natural vistas, energetic pacing, sun-flared golden light, immersive first-person energy",
  },
];

/** All style specs, both kinds. */
export const STYLE_SPECS: StyleSpec[] = [
  ...IMAGE_STYLE_SPECS,
  ...VIDEO_STYLE_SPECS,
];

/** Lookup a StyleSpec by id (searches both image and video). */
export function getStyleSpec(id: string): StyleSpec | undefined {
  return STYLE_SPECS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Docs — document-type specs (Docs mode gallery: "Choose a document"). Each
// carries a compact structural preview (an ordered outline the gallery renders
// as a skeleton) plus a promptFragment the contract loader appends so the
// document-editor produces the right shape. These are document skeletons, not
// visual themes — the active brand still styles the output.
// ---------------------------------------------------------------------------

export interface DocTypeSpec {
  /** Stable id used in CreateIntent.templateId (docs mode). */
  id: string;
  /** Human-facing name shown in the gallery. */
  name: string;
  /** One-line description of the document shape. */
  description: string;
  /**
   * The document's section outline — rendered as a small structural preview
   * (skeleton lines) in the gallery card, and appended to the prompt so the
   * doc comes out with the right sections.
   */
  outline: string[];
  /** "reach for this when…" guidance. */
  bestFor: string;
}

/** 4 document-type specs (One-pager / PRD / Tech spec / Proposal). */
export const DOC_TYPE_SPECS: DocTypeSpec[] = [
  {
    id: "one_pager",
    name: "One-pager",
    description: "A single-page brief — title, problem, solution, the ask.",
    outline: ["Title", "Problem", "Solution", "The ask"],
    bestFor: "Fast exec briefs, pitch summaries, project one-pagers",
  },
  {
    id: "prd",
    name: "PRD",
    description:
      "A full product requirements doc — goals, scope, specs, rollout.",
    outline: [
      "Overview",
      "Goals & non-goals",
      "Scope",
      "Requirements",
      "Specs",
      "Rollout plan",
    ],
    bestFor: "Product specs, feature definition, cross-functional alignment",
  },
  {
    id: "tech_spec",
    name: "Tech spec",
    description:
      "An engineering design doc — architecture, API surface, risks.",
    outline: [
      "Context",
      "Architecture",
      "API surface",
      "Data model",
      "Risks & tradeoffs",
      "Milestones",
    ],
    bestFor: "System design, RFCs, engineering review docs",
  },
  {
    id: "proposal",
    name: "Proposal",
    description:
      "A client-facing proposal — overview, terms, timeline, pricing.",
    outline: [
      "Overview",
      "Approach",
      "Scope of work",
      "Timeline",
      "Terms & pricing",
      "Next steps",
    ],
    bestFor: "Client proposals, SOWs, partnership pitches",
  },
];

/** Lookup a DocTypeSpec by id. */
export function getDocTypeSpec(id: string): DocTypeSpec | undefined {
  return DOC_TYPE_SPECS.find((d) => d.id === id);
}

// ---------------------------------------------------------------------------
// Data — output-format + chart-type specs (Data mode gallery: "Output & chart
// types"). The user picks ONE output format and MULTI-SELECTs chart types. Both
// ride into the CreateIntent (format → mode hint on the app-builder prompt;
// chartTypes → CreateIntent.chartTypes).
// ---------------------------------------------------------------------------

export interface DataFormatSpec {
  /** Stable id used in CreateIntent (data output format). */
  id: string;
  /** Human-facing label. */
  label: string;
  /** One-line description of the output. */
  description: string;
}

/** 4 output formats (Dashboard / Report / Sheet / Slides). */
export const DATA_FORMAT_SPECS: DataFormatSpec[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    description: "An interactive dashboard — KPI tiles + live charts.",
  },
  {
    id: "report",
    label: "Report",
    description: "A written report with charts embedded inline.",
  },
  {
    id: "sheet",
    label: "Sheet",
    description: "A spreadsheet — tables, formulas, pivots.",
  },
  {
    id: "slides",
    label: "Slides",
    description: "A slide deck built around the data story.",
  },
];

/** Lookup a DataFormatSpec by id. */
export function getDataFormatSpec(id: string): DataFormatSpec | undefined {
  return DATA_FORMAT_SPECS.find((f) => f.id === id);
}

export interface ChartTypeSpec {
  /** Stable id — this is what lands in CreateIntent.chartTypes. */
  id: string;
  /** Human-facing label. */
  label: string;
}

/** 6 chart types (multi-select). */
export const CHART_TYPE_SPECS: ChartTypeSpec[] = [
  { id: "bar", label: "Bar" },
  { id: "line", label: "Line" },
  { id: "pie", label: "Pie" },
  { id: "scatter", label: "Scatter" },
  { id: "heatmap", label: "Heatmap" },
  { id: "area", label: "Area" },
];

// ---------------------------------------------------------------------------
// Canvas — action specs (Canvas mode gallery: "Choose an action"). A canvas
// action seeds the thread with a directive rather than a design contract; the
// gallery renders these as action cards. `promptSeed` is the prompt the action
// kicks off with.
// ---------------------------------------------------------------------------

/** Which small illustration a canvas action tile renders. */
export type CanvasActionGlyph = "plus" | "edit" | "upscale" | "cutout";

export interface CanvasActionSpec {
  /** Stable id used in CreateIntent (canvas action). */
  id: string;
  /** Human-facing label. */
  label: string;
  /** One-line description of what the action does. */
  description: string;
  /** Illustration hint for the gallery tile. */
  glyph: CanvasActionGlyph;
  /** The prompt this action seeds the thread with. */
  promptSeed: string;
}

/**
 * 4 canvas actions, matched to the SET-4 mock: Create new · Edit image ·
 * Upscale · Remove background. Each seeds the thread with its own directive
 * (rather than a design contract), and the gallery renders them as a 2×2 grid
 * of illustrative action tiles. `glyph` drives the tile's small illustration.
 */
export const CANVAS_ACTION_SPECS: CanvasActionSpec[] = [
  {
    id: "create_new",
    label: "Create new",
    description: "Start from a blank canvas or a prompt.",
    glyph: "plus",
    promptSeed: "Open a new blank image canvas — I'll describe what to create.",
  },
  {
    id: "edit_image",
    label: "Edit image",
    description: "Inpaint, extend or restyle an upload.",
    glyph: "edit",
    promptSeed:
      "I want to edit an image — help me inpaint, extend, or restyle an upload.",
  },
  {
    id: "upscale",
    label: "Upscale",
    description: "2× / 4× resolution, sharpen detail.",
    glyph: "upscale",
    promptSeed:
      "Upscale an image for me — 2× / 4× resolution and sharpen the detail.",
  },
  {
    id: "remove_background",
    label: "Remove background",
    description: "Cut the subject onto transparency.",
    glyph: "cutout",
    promptSeed:
      "Remove the background from an image — cut the subject onto transparency.",
  },
];

/** Lookup a CanvasActionSpec by id. */
export function getCanvasActionSpec(id: string): CanvasActionSpec | undefined {
  return CANVAS_ACTION_SPECS.find((a) => a.id === id);
}
