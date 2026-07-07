# Cue Hosting Economics — Per-Customer Instance Hosting (July 2026)

**Scope.** Productizing Cue's current shape: one Bun/Node daemon + gateway per customer, SQLite (25–500MB) + 1–5GB file workspace on persistent disk, long-running watchers + 30-min heartbeat (can't fully scale to zero), ~300–700MB RSS, outbound to OpenRouter/Replicate, **must egress from US IPs**. Today: one Docker image on Render at ~$25–35/mo/instance.

**Bottom line up front:**
- **Alpha (≤30 customers): Fly.io Machines, one app per customer, always-on** — ~$4–6/customer/mo, best-in-class provisioning API, near-zero migration from the existing Docker image. (Staying on Render is fine too, just 5–8× the cost.)
- **Beta/growth (50–500): dense single-tenant containers on OVHcloud US bare metal (Vint Hill/Hillsboro)** with Docker Compose + a small provisioner (optionally Dokploy/Coolify), Litestream/restic backups to Cloudflare R2 — **~$1.2–2/customer/mo all-in**.
- **Multi-tenant rewrite: NOT economically justified below ~1,000–2,000 customers.** At 500 customers it saves only ~$400–600/mo vs dense containers — months of engineering to save a mid-four-figure annual sum, while giving up the isolation that per-user agent products (n8n cloud, Supabase, OpenClaw hosts) deliberately keep.
- **Landscape caveat:** Hetzner — the usual answer here — **tripled US prices on June 15, 2026** and offers no US dedicated servers, knocking it out of this race. 2026 RAM/SSD inflation is pushing all providers up; lock 12-month terms where offered.

---

## 1. The July 2026 pricing landscape (and the Hetzner surprise)

Hetzner raised prices three times in 2026 (April, then a major June 15 "standardization"). The **US locations (Ashburn ASH, Hillsboro HIL) took +107–204%**: CPX11 (2 vCPU/2GB) went **$6.99 → $20.49/mo**; CPX41 roughly tripled (€38.99 → €120.49). Hetzner cited RAM/SSD component costs (DRAM contract prices +~95% in Q1 2026 alone). Existing servers keep old pricing; **new orders and rescales pay new prices** — so you cannot build a fleet on old Hetzner US pricing. Hetzner also **does not offer dedicated (Robot) servers in the US at all** — US locations are colocation-based cloud only. HN reaction was blunt ("3x is wild"). ([Hetzner price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [heise](https://www.heise.de/en/news/Up-to-200-percent-Cloud-hoster-Hetzner-adjusts-prices-again-11333037.html), [wz-it breakdown](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/), [HN](https://news.ycombinator.com/item?id=48540844), [cybernews](https://cybernews.com/security/hetzner-increases-vps-hosting-price/))

At the new US rates, Hetzner is ~$8–10 per GB-RAM/mo — **worse than DigitalOcean**. Since Cue must run from US IPs (OpenRouter regional blocks), Hetzner's cheap EU metal is irrelevant, and **OVHcloud US becomes the commodity-density winner**. OVH's own 2026 increase was comparatively mild (+9–11% avg on bare metal, [OVH blog](https://blog.ovhcloud.com/pricing-evolution-of-public-cloud-bare-metal-and-vps-at-ovhcloud/)).

### Commodity infra — verified US prices (July 2026)

| Provider | Offering | Specs | $/mo | $/GB-RAM/mo |
|---|---|---|---|---|
| **OVH US ECO — Kimsufi** | dedicated, Vint Hill/Hillsboro | from 4c/16GB | **from $10** | ~$0.6 |
| **OVH US ECO — So you Start** | dedicated | 6–24c / 32–512GB, 500Mbps | **from $30** | ~$0.5–0.9 |
| **OVH US — Rise-S** | dedicated | Ryzen 7 9700X 8c/16t, 64GB, 2×512GB NVMe, 1Gbps unmetered | **$77** (+$77 setup, waived on 12-mo) | **$1.20** |
| **OVH US — RISE-1** | dedicated | Xeon-E 2386G 6c/12t, 32GB base | **$70**, no setup | $2.19 |
| Hetzner US (new) | cloud VPS | CPX11 2vCPU/2GB | $20.49 | $10.25 |
| Hetzner US (new) | cloud VPS | CPX51 16vCPU/32GB | $279.49 | $8.73 |
| DigitalOcean | basic droplet | 1vCPU/512MB / 1GB / 2GB | $4 / $6 / $12 | ~$6 |
| Vultr | cloud compute | 1vCPU/1GB; HF 2GB | $5–6; $12 | ~$5–6 |
| Vultr | block storage | NVMe | $0.10/GB | — |

Backup storage: **Cloudflare R2 $0.015/GB/mo, zero egress**; Hetzner Storage Box BX11 **€3.20/mo for 1TB** (EU-located — fine for cold backups); Backblaze B2 ~$6/TB. ([R2/storage comparison](https://www.keydal.net/storage-server-price-comparison), [BX11](https://www.hetzner.com/storage/storage-box/bx11/))

---

## 2. Option A — Dense single-tenant containers on OVH US bare metal

### Density math
Per-tenant budget: 700MB RSS worst-case + burst headroom → plan **~1GB/tenant** with 25–30% host overcommit slack, 5GB disk.

- **Rise-S ($77, 64GB, ~1TB NVMe RAID):** ~60GB usable → **55–65 tenants comfortably** (85+ if the 300–500MB typical RSS holds; don't plan on it). Disk: 65 × 5GB = 325GB — fine. CPU: 16 threads across ~60 mostly-idle daemons — fine; the heartbeats are staggered.
- **So you Start 32GB ($30):** ~25–28 tenants — the right alpha box.

### $/customer/mo (incl. R2 backups ~$0.08/tenant, small $6–12 control VPS, monitoring)

| Scale | Hardware | Total infra | **$/customer** |
|---|---|---|---|
| 20 | 1× SYS-32GB $30 (or Rise-S $77 for headroom) + backups | ~$40–90 | **$2.00–4.50** |
| 100 | 2× Rise-S $154 + control $12 + backups $10 | ~$176 | **$1.76** |
| 500 | 8–9× Rise-S ~$650 + control/LB $25 + backups $40 + spare capacity | ~$715–790 | **$1.43–1.58** |

Failure domain warning: one box = 60 customers down. From ~50 customers run **N+1 boxes** and keep per-tenant restore (SQLite file + workspace from R2) scripted and tested — SQLite-per-tenant makes DR "copy one file back," which is exactly why 37signals is building Fizzy this way ([37signals on Rails multi-tenancy/SQLite-per-customer](https://dev.37signals.com/rails-multi-tenancy/), [ServiceStack on scalable SQLite + cheap EPYC metal](https://servicestack.net/posts/scalable-sqlite)). A recent Show HN runs a whole production SaaS on one ~$25 node with Coolify + SQLite and calls it "surprisingly stable, just works" ([HN](https://news.ycombinator.com/item?id=46824934)).

### Orchestration at this scale
- **Plain Docker Compose per tenant + your own provisioner (recommended at ≤500):** a ~500-line service that templates a compose file per tenant, assigns a subdomain via a shared Caddy/Traefik front, registers backup jobs. You already have the Compose file. Boring, debuggable, no platform to babysit. Ops burden 4/5 (you own the host), but the automation surface is small.
- **Coolify / Dokploy (self-hosted PaaS):** both have REST APIs usable for programmatic per-tenant app creation; Coolify v4 adds an MCP server and multi-server management; Dokploy is Docker-Swarm-based with an Organizations concept and lighter idle footprint (~0.8GB vs 1.2GB) ([Contabo comparison](https://contabo.com/blog/blog-coolify-vs-dokploy-comparison/), [Coolify API docs](https://coolify.io/docs/api-reference/api/operations/create-public-application), [Dokploy vs Coolify](https://dokploy.com/dokploy-vs-coolify)). Maturity verdict: fine as a dashboard + deploy plumbing for tens of tenants; for 500 identical tenants a bespoke provisioner is *less* code than driving a general-purpose PaaS API, and you avoid platform-upgrade risk. Reasonable middle: Dokploy for host/proxy management, your provisioner calling its API.
- **k3s:** clean primitives (one namespace per tenant, StatefulSet + PVC), but adds etcd/ingress/CSI operational surface for zero economic gain at ≤500 tenants on 2–9 boxes. Only worth it if you already speak Kubernetes fluently. Ops burden 4/5.

---

## 3. Option B — Fly.io Machines (per-customer app)

Verified pricing ([Fly docs](https://fly.io/docs/about/pricing/)): shared-cpu-1x **512MB $3.19/mo**, **1GB $5.70/mo**, 2GB $10.70/mo (per-second billing); volumes **$0.15/GB/mo**; snapshots $0.08/GB (10GB free); **stopped machines pay $0.15/GB of rootfs**; dedicated IPv4 $2/mo (shared IPv4/SNI is free); NA egress $0.02/GB. Support plans from $29/mo are optional.

- **Always-on, 1 app per customer:** 1GB machine $5.70 + 3GB volume $0.45 = **$6.15/customer/mo** (512MB: **$3.64**). No platform fee. Linear at every scale.
- **Scale-to-zero with cron-wake — yes, it's viable, with caveats.** Machines support `--schedule hourly|daily|weekly|monthly` (Fly starts the machine on the interval; it does its work and exits/stops) ([scheduled machines](https://community.fly.io/t/new-feature-scheduled-machines/7398), [task-scheduling blueprint](https://fly.io/docs/blueprints/task-scheduling/)). Granularity is coarse — hourly is the finest — so the 30-min heartbeat becomes hourly, or you drive precise wakes from one tiny always-on scheduler machine (or GitHub Actions cron) hitting the Machines REST API. Crucially, **fly-proxy auto-start means any inbound HTTP wakes the machine** — so Gmail/Google Calendar *push webhooks and user sessions wake the tenant for free*; watchers become "poll on wake" instead of resident processes. Economics at ~10–15% duty cycle: compute ~$0.60–0.90 + rootfs-stopped ~$0.30 (2GB image) + volume $0.45 ≈ **$1.40–1.80/customer/mo**. That matches bare-metal density *without* owning servers — but it's a real (if modest) app change: idempotent wake, catch-up-on-boot, tolerance for 30–60 min watcher latency (already partially built per the daemon's cron-wake work).
- **Provisioning API: the best of any option here.** Apps/Machines/Volumes are first-class REST resources designed exactly for "one app per tenant" fleets; per-tenant isolation is Firecracker microVMs (no shared kernel) ([Fly security](https://fly.io/security/)).
- **Caveats:** community-reported reliability wobbles through 2025–26 ("machine stopped responding" threads), free tier gone, per-second billing punishes accidental overprovision ([Ask HN](https://news.ycombinator.com/item?id=34229751), [alternatives roundup](https://expresstech.io/7-fly-io-alternatives-in-2026-real-pricing-after-the-free-tier-died/)). Volumes are single-host — snapshot + restore is your DR story. Run tenants in `iad`/`ord`/`sjc` for US IPs.

---

## 4. Option C — Railway / Northflank / Porter / Koyeb (and Render baseline)

| Platform | Pricing model (verified) | Cue instance (always-on, ~0.5–1GB + 3GB vol) | Notes |
|---|---|---|---|
| **Railway** | $20/vCPU/mo + $10/GB-RAM/mo, per-second on *actual* usage; volumes $0.15/GB; Hobby $5 / Pro $20 seat incl. credit ([docs](https://docs.railway.com/pricing/plans)) | ~0.5GB RAM $5 + ~0.1 avg vCPU $2 + vol $0.45 ≈ **$7–9** | Good API (GraphQL), templates, per-service isolation is containers not VMs. US regions available. |
| **Northflank** | $0.01667/vCPU/hr (~$12.2/mo) + $0.00833/GB/hr (~$6.1/mo), per-second; SSD $0.15/GB/mo; egress $0.06/GB ([pricing](https://northflank.com/pricing)) | 0.25 vCPU + 512MB ≈ $3 + $3 + $0.45 ≈ **$6.50** | Strongest "platform-in-a-platform" story: projects/templates/API built for per-tenant provisioning; **BYOC mode can run its control plane over your own OVH/GCP boxes later** — a credible bridge from PaaS to metal. |
| **Koyeb** | eSmall (1GB) **$5.36/mo**; Pro plan $29/mo incl. $10 usage; 100GB egress free ([pricing](https://www.koyeb.com/pricing), [eco instances](https://www.koyeb.com/blog/new-eco-instances-the-most-affordable-way-to-deploy-apps-globally)) | ≈ **$6–7** incl. plan amortization | Washington-DC region for US IP. Volumes still maturing — check before committing state. |
| **Porter** | BYOC on AWS/GCP/Azure; default infra ~**$300/mo** + usage ([HN](https://news.ycombinator.com/item?id=36329874), [pricing](https://www.porter.run/pricing)) | n/a at this scale | K8s-on-your-cloud; wrong shape until you're big enough to want EKS anyway. |
| **Render (today)** | Starter 512MB $7/service, Standard $25; disks ~$0.25/GB; workspace plans on top ([pricing](https://render.com/pricing)) | **$25–35 (current reality)** | The baseline you're escaping: 15–25× bare-metal cost per customer at scale. |

---

## 5. Ranked comparison ($/customer/mo, all-in incl. backups/control plane)

| Rank | Option | @20 | @100 | @500 | Ops (1=easy) | Isolation | Prov. API | Migration from current image |
|---|---|---|---|---|---|---|---|---|
| 1 | **OVH US metal + Compose/provisioner** | $2.50–4.50 | **$1.76** | **$1.45–1.60** | 4 | container (shared kernel) | you build it (small) | Low — same image, new plumbing |
| 2 | **Fly Machines, scale-to-zero + cron/webhook wake** | $1.50–2.00 | $1.50–2.00 | $1.50–2.00 | 3 | **microVM** | **excellent** | Medium — wake-pattern app changes |
| 3 | **Fly Machines, always-on 512MB–1GB** | $3.65–6.15 | $3.65–6.15 | $3.65–6.15 | **2** | **microVM** | **excellent** | **Trivial** |
| 4 | OVH metal + Coolify/Dokploy | $2.50–5 | ~$2 | ~$1.8 | 3 | container | moderate (REST, quirks) | Low |
| 5 | Koyeb / Northflank | $6–7 | $6–7 | $6–7 | 2 | container/microVM | good | Trivial |
| 6 | Railway | $7–9 | $7–9 | $7–9 | 2 | container | good (GraphQL) | Trivial |
| 7 | DO/Vultr VPS-per-tenant or dense-VPS | $5–7 | $4–6 | $4–6 | 3–4 | VM or container | DO API good | Low |
| 8 | Hetzner US (post-June-2026) | $9–12 | $8–10 | $8–10 | 4 | container | Hetzner API good | Low — but pricing now uncompetitive |
| 9 | Render (status quo) | $25–35 | $25–35 | $25–35 | 1 | container | OK | none |

*(Monthly totals at 500: OVH ~$720–790; Fly scale-to-zero ~$750–1,000; Fly always-on ~$1,825–3,075; Railway/Koyeb ~$3,000–4,500; Render ~$12,500–17,500.)*

---

## 6. Multi-tenant rewrite — what it would actually save

Shared Node process (or process pool) + per-tenant SQLite files on one box. Sizing: shared runtime amortizes the ~250–400MB base RSS; incremental per-tenant working set maybe 30–80MB hot / near-0 cold.

| Scale | Multi-tenant infra | $/cust | Dense-container infra | **Savings/mo** |
|---|---|---|---|---|
| 20 | 1× $24 DO 4GB + backups ≈ $30 | $1.50 | ~$80 | **~$50** |
| 100 | 1× Rise-S $77 (+standby) ≈ $120 | $1.20 | ~$176 | **~$56** |
| 500 | 2–3× Rise-S + LB ≈ $200–260 | $0.40–0.50 | ~$715–790 | **~$460–560** |

**Verdict: the rewrite is not economically justified at these scales.** Peak saving ≈ $6–7k/year at 500 customers — far below the engineering cost (multi-month refactor of a daemon whose skills/jobs/workspace model assumes single-tenant), and it buys new problems: noisy neighbors under LLM-driven job bursts, one crash = everyone down, blast-radius on upgrades, harder per-tenant guardrails/trust boundaries, harder "export my instance"/self-host story (which Cue already sells). The economics only flip when tenant count × idle-RSS makes RAM the dominant bill at commodity prices — with bare-metal RAM at ~$1.2/GB-mo, that's roughly **1,500–2,000+ customers (infra bill >$2.5–3k/mo)**, or if per-customer price pressure demands sub-$1 COGS. Cheaper interim lever: shrink idle RSS (Bun heap tuning, lazy-loading skills) — every 100MB saved ≈ 15% more density.

---

## 7. What comparable products do

- **n8n cloud:** per-user isolated instance — each customer gets their own container with its own auth and encryption key, subdomain-routed; community consensus for multi-tenant n8n is "separate instance per tenant is the simplest and strongest" ([isolation model](https://deepwiki.com/knightsri/n8n-multi-user-server/2.2-isolation-and-security-model), [n8n community](https://community.n8n.io/t/best-practices-for-structuring-multi-customer-projects-in-n8n-centralized-vs-one-instance-per-customer/163345)).
- **Supabase:** every cloud project is its own isolated instance (own Postgres, API, auth) — "individual servers, the dashboard just makes it look like one place" ([discussion](https://github.com/orgs/supabase/discussions/38048)). They price from $10–25/project and eat thin margins at the low end for provisioning simplicity.
- **OpenClaw-style per-user agent hosting (closest comparable to Cue):** a whole cottage industry sells one VPS/container per user at **$2.99–15/mo** hosted price, with users' LLM API spend ($10–30/mo) dwarfing the infra line ([cybernews pricing survey](https://cybernews.com/vps/openclaw-hosting-price/), [cost breakdown](https://blink.new/blog/openclaw-total-cost-self-host-vs-managed-2026)). Lesson: per-instance isolation at $1–4 COGS supports a $20–50/mo price point comfortably; **your COGS story is the model bill, not the container.**
- **37signals (Fizzy):** deliberately going per-customer SQLite-file multi-tenancy on owned/cheap hardware — isolation via data layout, density via one app process ([37signals dev blog](https://dev.37signals.com/rails-multi-tenancy/)). That's the pattern to steal *if* Cue ever does the rewrite.
- **Cal.com:** conventional shared multi-tenant SaaS (one Postgres, row-level tenancy) — the counter-example; works because it's a CRUD app, not a per-user daemon running background agents with a private filesystem.

---

## 8. Recommendation (staged)

1. **Now → alpha (≤30 customers): Fly.io Machines, one app per customer, always-on 1GB + 3GB volume, region `iad`.** ~$6/customer, trivial migration (same Docker image), Machines REST API gives you programmatic signup→instance in minutes, microVM isolation is a security *upgrade* over Render. Accept the reliability wobble risk at alpha stakes; snapshot volumes daily to R2.
2. **During alpha, land the cron-wake/auto-stop pattern** (already half-built for daemon restarts): webhook-wake for mail/calendar push, `--schedule hourly` + catch-up-on-boot for heartbeats. That cuts Fly to ~$1.50–2/customer and — more importantly — makes the daemon tolerant of *any* stop/start substrate.
3. **Beta/growth (50–500): move the fleet to 2+ OVH US Rise-S boxes ($77, 64GB, Vint Hill + Hillsboro)** running the same per-tenant Compose stacks behind Caddy/Traefik, driven by a small provisioner service; per-tenant Litestream (SQLite WAL streaming) + nightly workspace restic to **Cloudflare R2**. ~$1.45–1.76/customer, N+1 from day one, keep Fly as overflow/burst and as the fast lane for instant signups while OVH capacity is provisioned (OVH bare-metal delivery is hours-to-days, not seconds — the provisioner should pre-warm capacity).
4. **Skip the multi-tenant rewrite** until ≥~1,500 customers or infra >$3k/mo; revisit as "shared process, per-tenant SQLite files" (Fizzy pattern), not as a shared-DB rewrite. Meanwhile, invest the saved engineering in shrinking idle RSS.
5. **Avoid:** Hetzner US (post-June-2026 pricing is 5–7× OVH per GB), Porter (wrong scale), k3s (complexity without payoff ≤500 tenants).

### Key sources
[Hetzner June 2026 price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) · [Hetzner pressroom](https://www.hetzner.com/pressroom/standardization-and-price-adjustment-of-our-server-products/) · [heise coverage](https://www.heise.de/en/news/Up-to-200-percent-Cloud-hoster-Hetzner-adjusts-prices-again-11333037.html) · [HN thread](https://news.ycombinator.com/item?id=48540844) · [OVH US Rise](https://eco.us.ovhcloud.com/rise/) · [OVH US ECO compare](https://eco.us.ovhcloud.com/compare/) · [OVH pricing evolution](https://blog.ovhcloud.com/pricing-evolution-of-public-cloud-bare-metal-and-vps-at-ovhcloud/) · [Fly.io pricing](https://fly.io/docs/about/pricing/) · [Fly scheduled machines](https://community.fly.io/t/new-feature-scheduled-machines/7398) · [Fly task-scheduling blueprint](https://fly.io/docs/blueprints/task-scheduling/) · [Railway pricing](https://docs.railway.com/pricing/plans) · [Northflank pricing](https://northflank.com/pricing) · [Koyeb pricing](https://www.koyeb.com/pricing) · [Render pricing](https://render.com/pricing) · [DO droplet pricing guide](https://infratally.com/articles/digitalocean-droplet-pricing-guide-2026/) · [Vultr pricing](https://www.vultr.com/pricing/) · [Coolify vs Dokploy](https://contabo.com/blog/blog-coolify-vs-dokploy-comparison/) · [Show HN: $25 Hetzner node + Coolify + SQLite](https://news.ycombinator.com/item?id=46824934) · [37signals multi-tenancy](https://dev.37signals.com/rails-multi-tenancy/) · [n8n isolation model](https://deepwiki.com/knightsri/n8n-multi-user-server/2.2-isolation-and-security-model) · [OpenClaw hosting price survey](https://cybernews.com/vps/openclaw-hosting-price/)
