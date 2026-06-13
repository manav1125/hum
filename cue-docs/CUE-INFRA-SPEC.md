# Cue — Self-Host Infrastructure & CI/CD Spec

Decision (2026-06-13): **self-host on our own cloud**, not the managed Vellum Platform.
This spec is the deploy half of `CUE-BUILD-HANDOFF.md`. Goal: ship a private, single-tenant
Cue that any of our users can run on their own cloud, with the same codebase and data model.

## 1. Runtime topology (what runs)
Four long-running components (from `ARCHITECTURE.md`), kept as separate images/processes:
| Component | Source | Role | Isolation |
| --- | --- | --- | --- |
| **assistant** | `assistant/` (Dockerfile present) | the brain: memory, runtime, tools, channels | app tier |
| **gateway** | `gateway/` | **only public ingress** — webhooks, OAuth callbacks, channel inbound | edge tier |
| **CES** | `credential-executor/` | Credential Execution Service — holds secrets, runs credentialed calls | **hard-isolated**; own security volume |
| **egress-proxy** | `packages/egress-proxy` | controlled outbound for CES secure commands | network tier |

Invariants to preserve in infra: public traffic hits **gateway only**; CES runs as its own
container with a private security volume no other container mounts; assistant↔CES is RPC/Unix-socket
(local) or the CES HTTP API with `CES_SERVICE_TOKEN` (Docker). Don't collapse these into one image.

## 2. Two deployment tiers (pick per need)
**A. Self-host MVP — single VM + Docker Compose** (recommended start)
- One VM (e.g., 4 vCPU / 16 GB), Docker + Compose, the four images on a private network, only
  gateway's TLS port exposed. Caddy/Traefik for TLS + reverse proxy. Volumes on the host (or a
  block volume). Simplest path to a real, private, running Cue.

**B. Scale tier — managed Kubernetes** (when multi-tenant / HA)
- GKE or EKS. Each component a Deployment; gateway behind an Ingress/LB with TLS; CES as a
  StatefulSet with a dedicated PVC + tight NetworkPolicy; assistant horizontally scalable;
  secrets in the cloud secret manager. (The fork references `vembda` pod-templates for the
  managed analog — mirror that shape.)

## 3. Cloud provider — recommendation
Default **GCP** (clean managed k8s in GKE, Secret Manager, Artifact Registry, Cloud Storage for
releases/backups). **AWS** is an equally valid alternative (EKS, Secrets Manager, ECR, S3). Decision
still open in `ROADMAP.md`; the Compose MVP is provider-agnostic, so we can defer the k8s/provider
choice until we need tier B. Pick one before writing the Terraform.

## 4. Storage & data
- Per-assistant workspace/memory volume (the 8-type memory + workspace files).
- **CES security volume** (`/ces-security`: `keys.enc`, `store.key`) — mounted only by CES.
- Postgres/SQLite per the fork's data layer (confirm in `assistant/` at build time).
- Object storage for backups + release artifacts.
- Backups: `assistant/src/backup` + `export` already exist — schedule snapshots of the memory
  volume; encrypt at rest; test restore.

## 5. Networking, domains, OAuth
- One domain per deploy (e.g., `app.<tenant>.cue.so` or the user's own). TLS everywhere.
- Gateway terminates inbound: webhooks (Slack/Twilio/Telegram/email), OAuth callbacks
  (`/account/provider/callback`, `/assistant/oauth/*`), channel inbound. Nothing else is public.
- Per-provider OAuth apps/keys held in the secret manager → surfaced to CES, never to the model.

## 6. Secrets & config
- Cloud secret manager (or Compose `.env` + host perms for MVP): `CES_SERVICE_TOKEN`,
  per-provider LLM keys, OAuth client secrets, Twilio/voice keys.
- LLM keys: route via the **provider abstraction**. Cue's assistant brain runs on **Claude Fable 5
  (`claude-fable-5`) only** ($10 / $50 per MTok, 1M context, adaptive thinking always on). Embeddings
  stay local (ONNX) per the fork; Ollama remains available for embeddings/offline, but the reasoning
  model is Fable 5.
- Feature flags via `meta/feature-flags/feature-flag-registry.json` — gate new surfaces/Cue Live.

## 7. CI/CD (GitHub Actions → our cloud)
```
on push to main / release tag:
  1. install (bun) → lint → bun test (+ guard tests) → typecheck
  2. build images: assistant, gateway, CES, egress-proxy  (matrix)
  3. push to registry (Artifact Registry / ECR), tagged by SHA + semver
  4. deploy:
       MVP (Compose):  ssh + `docker compose pull && up -d` on the VM
       Scale (k8s):    apply manifests / Helm; rolling update; CES updated with care
  5. post-deploy: health checks on gateway; smoke test; notify
```
- macOS desktop app + iOS are a **separate pipeline**: electron-builder (notarize/sign) →
  publish to the releases bucket (`apps/macos` already points at a GCS releases URL — repoint to
  ours); iOS archive → TestFlight. Code-signing certs in CI secrets.
- Environments: `dev` → `staging` → `production` (the fork's `VELLUM_ENVIRONMENT` seeds map here;
  becomes `CUE_ENVIRONMENT` in the Phase-1b deep rename).

## 8. Observability & ops
- Logs/metrics/traces: the fork has `telemetry/` + `logs` domain + `instrument.ts` (Sentry-style).
  Wire to our stack (e.g., Grafana/Loki or the cloud-native equivalent).
- Health: gateway liveness/readiness; CES isolation check; disk-pressure guard (the app already
  has a 95% storage-cleanup mode — surface it in ops alerts).
- Runbooks: extend `assistant/docs/runbook-*`.

## 9. Security posture (self-host selling point)
- Data stays in the user's cloud; CES isolation preserved; secure fields never logged.
- This pairs with Cue Live's AX-first/no-screenshot default — privacy by construction is the
  differentiator vs. the cloud-capture competitors (see `CUE-LIVE-RESEARCH.md`).

## 10. Build order for infra (slots into the handoff sequence)
1. Dockerfiles audit (assistant has one; confirm gateway/CES/egress) + a `docker-compose.yml`.
2. Compose MVP on one VM behind Caddy TLS → first private running Cue.
3. GitHub Actions: test → build → push → deploy-to-VM.
4. Desktop/iOS release pipeline (sign/notarize/TestFlight) + repoint release buckets to ours.
5. Pick provider; write Terraform for tier B (GKE/EKS) when scale demands.
6. Backups + observability + runbooks.

## 11. Open decisions
- GCP vs AWS for tier B (MVP is provider-agnostic — safe to defer).
- Managed Postgres vs in-container; single-tenant per-VM vs multi-tenant k8s.
- Domain strategy (our subdomains vs bring-your-own).
