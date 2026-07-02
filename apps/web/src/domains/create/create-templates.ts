/**
 * Template catalog for the "What do you want to get done?" Create surface.
 *
 * Each mode maps to a REAL Cue skill (see `skill` field — these are the
 * activation hints the assistant routes on). Picking a template seeds a new
 * chat thread with `prompt` via the standard `?prompt=` auto-send path
 * (apps/web/src/domains/chat/hooks/use-auto-send-effects.ts), so the asset
 * is actually produced by the backing skill — not a mock.
 *
 * Skill mapping (verified against assistant/src/config/bundled-skills/*):
 *   - app-builder      → dashboards, trackers, calculators, charts, slide decks, simple landing pages
 *   - document-editor  → long-form docs (PRDs, reports, articles, meeting notes)
 *   - image-studio     → generate / edit images (also background removal, restyle)
 *   - media-processing → analyze a video, extract clips, query footage
 *   - vellum-browser-use + built-in web research → competitor scans, market briefs
 *   - replicate        → generate images & video from any Replicate model (replicate_run)
 *   - apify            → lead generation / web scraping via Apify actors (apify_run_actor)
 *
 * The structured Image / Video / Leads form templates (create-form-templates.ts)
 * route to the `replicate` and `apify` daemon skills, whose provider keys are
 * configured at runtime — so they actually generate media / scrape leads.
 */

import {
  BarChart3,
  Table2,
  FileText,
  Image as ImageIcon,
  Music,
  Palette,
  Presentation,
  Search,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";

/** Canonical Cue skill a template routes to. */
export type CreateSkill =
  | "app-builder"
  | "document-editor"
  | "image-studio"
  | "media-processing"
  | "spreadsheet-studio"
  | "research"
  // Daemon skills wired to real provider keys (Replicate / Apify):
  | "replicate" // replicate_run — any image/video generation model
  | "apify"; // apify_run_actor — lead-gen / web-scraping actors

export interface CreateTemplate {
  /** Stable id (mode-scoped). */
  id: string;
  /** Card title. */
  title: string;
  /** One-line description of the asset. */
  description: string;
  /**
   * Prefilled prompt sent to a fresh chat thread. Worded to trigger the
   * backing skill's activation hints so the asset is actually produced.
   */
  prompt: string;
}

export interface CreateMode {
  id: string;
  label: string;
  /** Short tagline shown under the mode label. */
  tagline: string;
  icon: LucideIcon;
  /** The Cue skill every template in this mode invokes. */
  skill: CreateSkill;
  /** Human-readable name of the backing skill (shown as a chip on cards). */
  skillLabel: string;
  templates: CreateTemplate[];
}

export const CREATE_MODES: CreateMode[] = [
  {
    id: "slides",
    label: "Slides",
    tagline: "Decks built as interactive apps",
    icon: Presentation,
    skill: "app-builder",
    skillLabel: "App Builder",
    templates: [
      {
        id: "investor-pitch",
        title: "Investor pitch deck",
        description: "Series A deck: problem, market, traction, ask.",
        prompt:
          "Build me an investor pitch deck as a slide-deck app. Include slides for: problem, solution, market size (TAM/SAM/SOM), product, traction, business model, competition, team, financial projections, and the funding ask. Use a confident, modern visual direction with strong typography and one clear idea per slide. Add placeholder content I can edit and make it presentable as-is.",
      },
      {
        id: "qbr",
        title: "Quarterly business review",
        description: "KPIs, wins, risks, and next-quarter priorities.",
        prompt:
          "Build a quarterly business review slide deck as an app. Cover: executive summary, key KPIs with trend callouts, wins this quarter, what slipped and why, customer/revenue highlights, risks, and priorities for next quarter. Clean, data-forward design with one headline per slide.",
      },
      {
        id: "product-launch",
        title: "Product launch deck",
        description: "Positioning, demo flow, and go-to-market plan.",
        prompt:
          "Build a product launch presentation as a slide-deck app: positioning and value prop, the problem we solve, a demo walkthrough section, pricing/packaging, launch timeline, and the go-to-market plan. Energetic but professional visual direction.",
      },
      {
        id: "team-offsite",
        title: "Team offsite agenda",
        description: "Schedule, goals, and breakout sessions.",
        prompt:
          "Build a team offsite agenda as a slide deck app. Include: offsite goals, a time-blocked agenda for two days, breakout session topics, team-building activities, and a closing/next-steps slide. Warm, inviting visual direction.",
      },
    ],
  },
  {
    id: "data",
    label: "Dashboards",
    tagline: "Live trackers, dashboards & calculators",
    icon: BarChart3,
    skill: "app-builder",
    skillLabel: "App Builder",
    templates: [
      {
        id: "kpi-dashboard",
        title: "KPI dashboard",
        description: "At-a-glance metrics with charts and trends.",
        prompt:
          "Build me a KPI dashboard app. Show top-line metric cards (revenue, active users, growth %, churn) with trend indicators, plus a line chart of the primary metric over time and a bar chart breaking it down by segment. Seed it with realistic placeholder data I can replace, and make the layout precise and navy/finance-grade.",
      },
      {
        id: "budget-tracker",
        title: "Budget tracker",
        description: "Income, expenses, and running balance.",
        prompt:
          "Build a personal budget tracker app. Let me add income and expense entries by category, show a running balance, a spending-by-category pie chart, and a monthly total. Persist the entries so they stick between sessions.",
      },
      {
        id: "habit-tracker",
        title: "Habit tracker",
        description: "Daily streaks with a calendar heatmap.",
        prompt:
          "Build a habit tracker app where I can define a few habits and check them off each day. Show current streaks, a calendar heatmap of completions, and a weekly completion rate. Persist my data. Earthy, motivating visual direction.",
      },
      {
        id: "roi-calculator",
        title: "ROI calculator",
        description: "Interactive inputs with computed payback.",
        prompt:
          "Build an interactive ROI calculator app with input sliders/fields for cost, expected gain, and time horizon. Compute ROI %, net benefit, and payback period live as I change inputs, and visualize the breakeven point on a small chart.",
      },
    ],
  },
  {
    id: "docs",
    label: "Docs",
    tagline: "Long-form writing in the editor",
    icon: FileText,
    skill: "document-editor",
    skillLabel: "Document Writer",
    templates: [
      {
        id: "prd",
        title: "Product requirements doc",
        description: "Problem, goals, scope, and success metrics.",
        prompt:
          "Write a product requirements document (PRD) in the document editor. Include: overview & problem statement, goals and non-goals, target users, user stories, functional requirements, success metrics, risks, and an open-questions section. Use clear headings and leave editable placeholders for project-specific detail.",
      },
      {
        id: "meeting-notes",
        title: "Meeting notes",
        description: "Structured agenda, decisions, and action items.",
        prompt:
          "Create a meeting notes document in the editor with sections for attendees, agenda, discussion notes, decisions made, and action items (with owner and due date). Give me a clean reusable structure I can fill in during the meeting.",
      },
      {
        id: "blog-post",
        title: "Blog post",
        description: "A drafted article ready to edit and publish.",
        prompt:
          "Write a blog post in the document editor. Ask me nothing further if you can infer a sensible topic from context; otherwise pick an engaging tech/product topic. Include a strong hook, 3–4 well-structured sections with subheadings, and a closing call to action. Make it genuinely readable, not filler.",
      },
      {
        id: "one-pager",
        title: "Strategy one-pager",
        description: "A crisp single-page strategic brief.",
        prompt:
          "Write a strategy one-pager in the document editor: context, the decision or recommendation, supporting rationale, trade-offs considered, and next steps. Keep it tight and skimmable — this should fit on a single page.",
      },
    ],
  },
  {
    id: "sheets",
    label: "Sheets",
    tagline: "Real spreadsheets & financial models",
    icon: Table2,
    skill: "spreadsheet-studio",
    skillLabel: "Spreadsheet Studio",
    templates: [
      {
        id: "financial-model",
        title: "SaaS financial model",
        description: "3-year model with live formulas.",
        prompt:
          "Build me a SaaS financial model as a real Excel spreadsheet: an Assumptions sheet (starting MRR, growth %, churn %, CAC, headcount costs), a monthly model sheet computing MRR build-up, revenue, costs, and EBITDA entirely with live formulas referencing the assumptions, and an annual summary. Deliver it as an .xlsx I can open and tweak — changing an assumption must recalculate everything.",
      },
      {
        id: "budget-sheet",
        title: "Budget spreadsheet",
        description: "Categories × months with totals and variance.",
        prompt:
          "Build a budget spreadsheet as a real .xlsx: expense categories down the rows, months across the columns, with live SUM formulas for row and column totals and a variance column against a plan. I'll tell you the categories and rough numbers — everything derivable must be a formula.",
      },
      {
        id: "sales-tracker",
        title: "Sales pipeline sheet",
        description: "Deals, stages, weighted forecast.",
        prompt:
          "Build a sales pipeline spreadsheet as a real .xlsx: deals down the rows with columns for stage, amount, close probability, and a weighted-value formula (amount × probability), plus a summary section computing the total weighted forecast with live formulas.",
      },
    ],
  },
  {
    id: "research",
    label: "Research",
    tagline: "Web research, synthesized",
    icon: Search,
    skill: "research",
    skillLabel: "Web + Browser",
    templates: [
      {
        id: "competitor-scan",
        title: "Competitor scan",
        description: "Research rivals and compare positioning.",
        prompt:
          "Research my main competitors on the web and put together a competitor scan. For each one capture: what they do, target customer, pricing if public, key differentiators, and recent moves. Then give me a short comparison and where there's an opening. Browse their sites where useful. Ask me who the competitors are if it isn't obvious from context.",
      },
      {
        id: "market-brief",
        title: "Market brief",
        description: "Size, trends, and key players in a space.",
        prompt:
          "Research and write a market brief on a space I'll specify (ask me which one). Cover: market size and growth, major trends, key players, customer segments, and risks/opportunities. Cite sources from the web and keep it to a tight, decision-useful brief.",
      },
      {
        id: "person-brief",
        title: "Person / company brief",
        description: "Background research before a meeting.",
        prompt:
          "Do background research on a person or company I'll name (ask me who). Pull together a briefing: who they are, role/history, recent news, notable work, and a few smart talking points for a meeting. Use the web and cite where each fact came from.",
      },
      {
        id: "topic-deep-dive",
        title: "Topic deep dive",
        description: "A sourced explainer on any subject.",
        prompt:
          "Research a topic I'll give you (ask me what) and write a clear, sourced explainer: the essentials, how it works, the main viewpoints or approaches, and what's commonly misunderstood. Cite your web sources inline.",
      },
    ],
  },
  {
    id: "images",
    label: "Images",
    tagline: "Generate visuals from a prompt",
    icon: ImageIcon,
    skill: "replicate",
    skillLabel: "Replicate",
    templates: [
      {
        id: "hero-image",
        title: "Hero image",
        description: "A polished banner for a site or deck.",
        prompt:
          "Generate a striking hero/banner image I can use at the top of a landing page. Aim for a clean, modern, professional look with room for overlaid text. Describe a sensible subject if I don't specify one, then create it.",
      },
      {
        id: "logo-concepts",
        title: "Logo concepts",
        description: "A few distinct logo directions to choose from.",
        prompt:
          "Generate a few distinct logo concept variations for a brand (ask me the name and vibe if not given). Make them visually different from each other — different styles and color directions — so I can pick a direction.",
      },
      {
        id: "social-graphic",
        title: "Social graphic",
        description: "An eye-catching square post image.",
        prompt:
          "Generate an eye-catching square social media graphic. Bold, scroll-stopping composition with space for a short headline. Tell me a sensible theme if I don't give one, then create it.",
      },
      {
        id: "illustration",
        title: "Illustration",
        description: "A custom illustration in a chosen style.",
        prompt:
          "Generate a custom illustration. Pick a cohesive art style (flat, isometric, watercolor — your call unless I specify) and a subject that fits the context. Produce a clean, usable result.",
      },
    ],
  },
  {
    id: "canvas",
    label: "Canvas",
    tagline: "Edit & transform existing images",
    icon: Palette,
    skill: "image-studio",
    skillLabel: "Image Studio",
    templates: [
      {
        id: "remove-bg",
        title: "Remove background",
        description: "Cut out the subject from an image.",
        prompt:
          "I want to remove the background from an image. I'll attach it next — cleanly cut out the main subject and give me back a version with the background removed.",
      },
      {
        id: "restyle",
        title: "Restyle an image",
        description: "Reimagine a photo in a new style.",
        prompt:
          "I want to restyle an image I'll attach — reimagine it in a new artistic style while keeping the core composition. Suggest a couple of style directions and apply the one I pick.",
      },
      {
        id: "retouch",
        title: "Retouch & clean up",
        description: "Remove blemishes or unwanted objects.",
        prompt:
          "I'll attach an image I want retouched — clean it up by removing blemishes or unwanted objects and improving the overall look, while keeping it natural.",
      },
    ],
  },
  {
    id: "video",
    label: "Video",
    tagline: "Generate clips, animate scenes, analyze footage",
    icon: Video,
    skill: "replicate",
    skillLabel: "Replicate",
    templates: [
      {
        id: "cinematic-clip",
        title: "Cinematic clip",
        description: "A short, filmic shot from a text prompt.",
        prompt:
          "Generate a short, cinematic video clip from a text prompt using a Replicate text-to-video model. Aim for a filmic look — nice lighting, shallow depth of field, smooth camera motion. Suggest a striking subject/scene if I don't give one, then create it and show me the result.",
      },
      {
        id: "product-reveal",
        title: "Product reveal",
        description: "A slick product shot in motion.",
        prompt:
          "Generate a short product-reveal video clip — a slick, well-lit hero shot of a product with subtle camera motion (slow rotate, push-in, or reveal), studio or lifestyle backdrop. Ask me the product if I don't say, then create it with a Replicate text-to-video model.",
      },
      {
        id: "logo-animation",
        title: "Logo animation",
        description: "An animated logo sting or reveal.",
        prompt:
          "Generate a short animated logo sting / reveal as a video clip — clean motion, a tasteful build-on or shimmer, brand-appropriate background. Tell me a sensible style if I don't specify, then create it with a Replicate text-to-video model.",
      },
      {
        id: "social-ad-clip",
        title: "Social ad clip",
        description: "A punchy vertical video for social.",
        prompt:
          "Generate a punchy short vertical (9:16) video clip for social — eye-catching motion that stops the scroll, room for a short caption. Ask me the topic/brand if I don't give one, then create it with a Replicate text-to-video model.",
      },
      {
        id: "anime-scene",
        title: "Anime scene",
        description: "A short anime / Ghibli-style animation.",
        prompt:
          "Generate a short anime / Ghibli-style animated video clip — soft painterly backgrounds, gentle camera drift, a whimsical subject. Suggest a charming scene if I don't specify one, then create it with a Replicate text-to-video model.",
      },
      {
        id: "explainer-clip",
        title: "Explainer clip",
        description: "A short clip that illustrates an idea.",
        prompt:
          "Generate a short video clip that visually illustrates a concept or idea I'll give you — clear, simple, motion that helps explain the point. Tell me the concept (or pick a good example), then create it with a Replicate text-to-video model.",
      },
      {
        id: "summarize-video",
        title: "Summarize a video",
        description: "Key moments and a written summary.",
        prompt:
          "I have a video I want analyzed — I'll attach or point you to the file. Ingest it, then give me a summary of what happens, the key moments with timestamps, and anything notable in the footage.",
      },
      {
        id: "find-moment",
        title: "Find a moment",
        description: "Locate a specific scene by description.",
        prompt:
          "I want to find specific moments in a video I'll provide. Once it's ingested, I'll describe what I'm looking for (e.g. 'every time someone speaks on camera' or 'the goal') and you find the timestamps.",
      },
      {
        id: "extract-clip",
        title: "Extract a clip",
        description: "Pull a short segment out of a video.",
        prompt:
          "I want to extract a short clip from a longer video I'll provide. Ingest it, help me pick the segment, and produce the clipped output.",
      },
    ],
  },
  {
    id: "audio",
    label: "Audio",
    tagline: "Generate music, voiceover & sound",
    icon: Music,
    skill: "replicate",
    skillLabel: "Replicate",
    templates: [
      {
        id: "background-music",
        title: "Background music",
        description: "An original track in a chosen mood.",
        prompt:
          "Generate an original background music track using a Replicate music-generation model. I'll give you a mood/genre and rough length (or pick something fitting) — produce an instrumental bed I could use under a video or podcast, and share the audio.",
      },
      {
        id: "voiceover",
        title: "Voiceover",
        description: "Natural narration from your script.",
        prompt:
          "Generate a natural-sounding voiceover from a script using a Replicate text-to-speech model. I'll paste the script and tell you the voice/tone I want (warm, energetic, neutral) — produce the narration audio and share it.",
      },
      {
        id: "sound-effect",
        title: "Sound effect",
        description: "A short custom sound or sting.",
        prompt:
          "Generate a short custom sound effect or audio sting using a Replicate audio-generation model. I'll describe the sound I need (a notification chime, a whoosh, an ambient loop) — create it and share the audio.",
      },
      {
        id: "podcast-intro",
        title: "Podcast intro",
        description: "A spoken hook over a music bed.",
        prompt:
          "Create a short podcast intro: generate an upbeat music bed with a Replicate music model and a spoken intro line with a Replicate text-to-speech model, then combine them into a single intro clip. I'll give you the show name and tagline.",
      },
    ],
  },
  {
    id: "leads",
    label: "Leads",
    tagline: "Find prospects & contacts via Apify",
    icon: Users,
    skill: "apify",
    skillLabel: "Apify",
    templates: [
      {
        id: "find-leads-quick",
        title: "Find leads",
        description: "Scrape a structured list of prospects by criteria.",
        prompt:
          "Use the apify_run_actor skill with an appropriate lead/contact scraping actor (an apollo- or linkedin-style scraper, e.g. apify/contact-info-scraper or a Google-search-based finder) to build a structured lead list. I'll specify the industry, role/title, location, and how many leads I want — return name, title, company, location, and contact info as a clean table.",
      },
      {
        id: "scrape-site-contacts",
        title: "Scrape site contacts",
        description: "Pull emails, phones, and socials from URLs.",
        prompt:
          "Use the apify_run_actor skill with the apify/contact-info-scraper actor to extract contact details (emails, phone numbers, social profiles) from a set of website URLs I'll provide. Return the results as a structured table grouped by source URL.",
      },
      {
        id: "company-list",
        title: "Build a company list",
        description: "Find companies matching a profile.",
        prompt:
          "Use the apify_run_actor skill with a suitable company/business scraping actor (e.g. a Google-search or maps-based actor) to build a list of companies matching a profile I'll describe (industry, size, location). Return company name, website, location, and any contact info found as a structured table.",
      },
    ],
  },
];
