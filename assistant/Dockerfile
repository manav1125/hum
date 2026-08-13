# Use debian as base image
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install bun (pinned version)
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"
ENV PATH="/root/.bun/bin:${PATH}"

# Copy shared packages needed by assistant's repo-local dependencies
COPY packages/ces-client ./packages/ces-client
# assistant-client is a gateway dependency — needed for the combined Cue app
# image (daemon + gateway co-located). Harmless for the standalone daemon.
COPY packages/assistant-client ./packages/assistant-client
COPY packages/service-contracts ./packages/service-contracts
COPY packages/credential-storage ./packages/credential-storage
COPY packages/egress-proxy ./packages/egress-proxy
COPY packages/environments ./packages/environments
COPY packages/gateway-client ./packages/gateway-client
COPY packages/ipc-server-utils ./packages/ipc-server-utils
COPY packages/skill-host-contracts ./packages/skill-host-contracts
COPY packages/slack-text ./packages/slack-text
COPY packages/twilio-client ./packages/twilio-client

# Install deps for shared packages whose source is loaded at runtime.
# Without this, bun's module resolution walks up from packages/<name>/src/
# and can't find the package's own deps (zod, transitive file: refs)
# because only assistant/node_modules gets populated.
RUN cd /app/packages/ces-client && bun install --frozen-lockfile
RUN cd /app/packages/gateway-client && bun install --frozen-lockfile
RUN cd /app/packages/service-contracts && bun install --frozen-lockfile

# Install assistant dependencies first for cache reuse
COPY assistant/package.json assistant/bun.lock ./assistant/
RUN cd /app/assistant && bun install --frozen-lockfile

# Copy bundled first-party skills and install their deps. The repo-root
# .dockerignore is the single source of truth for which skills (and which
# files within them) ship in the assistant image -- adding or removing a
# bundled skill is a .dockerignore edit, not a Dockerfile edit.
COPY skills ./skills
RUN set -eu; for pkg in /app/skills/*/package.json; do \
      [ -e "$pkg" ] || continue; \
      dir="$(dirname "$pkg")"; \
      echo "Installing dependencies for $dir"; \
      (cd "$dir" && (bun install --frozen-lockfile 2>/dev/null || bun install)); \
    done

# Copy assistant source so emit-manifest can resolve the skill's remaining
# `../../assistant/src/...` imports while walking the register() module
# graph. Those imports disappear when skill-isolation Phase 1 completes
# (plan PR 18); the collector host short-circuits before any runtime path
# touches them, so the emitted manifest is correct in the meantime.
COPY assistant ./assistant

# Ship the feature-flag registry (the per-package copies under src/config are
# gitignored/generated, so they are absent from a clean build). The daemon's
# assistant-feature-flags loader resolves `<app>/meta/feature-flags/…` as a
# fallback candidate — without this, newly-declared flags (e.g. marketplace)
# have no default in the image and resolve OFF regardless of defaultEnabled.
COPY meta ./meta

# Ship the curated plugin registry (plugins/registry.json — the commit-pinned
# allowlist WS-C built). The daemon's registry-file loader walks up from
# assistant/src looking for `plugins/registry.json`; without this COPY it falls
# to the empty embedded fallback and the marketplace shows zero plugins.
COPY plugins ./plugins

# Emit the meet-join manifest consumed by the daemon-side loader to
# register proxy tools/routes without importing the skill in-process.
RUN bun run /app/skills/meet-join/scripts/emit-manifest.ts \
      --output /app/skills/meet-join/manifest.json

# ── Gateway, co-located in the combined Cue app image ───────────────────────
# The gateway reaches the daemon over the Unix socket in the shared workspace,
# so on a single-service host (Render) it must live in the same image. The
# default assistant CMD below is unchanged (standalone daemon); the combined
# start command is supplied by the deploy (render.yaml dockerCommand ->
# docker-cue-app-entrypoint.sh). Shared packages it needs (assistant-client,
# ces-client, gateway-client, ipc-server-utils, service-contracts, slack-text,
# twilio-client) are already present under /app/packages.
COPY gateway/package.json gateway/bun.lock ./gateway/
RUN cd /app/gateway && bun install --frozen-lockfile --production
COPY gateway ./gateway

# Final stage
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a AS runner

WORKDIR /app/assistant

# Install runtime dependencies for Playwright and tree-sitter
RUN apt-get update && apt-get install -y \
    bubblewrap \
    ca-certificates \
    curl \
    debootstrap \
    debian-archive-keyring \
    debconf \
    e2fsprogs \
    ffmpeg \
    fonts-freefont-ttf \
    g++ \
    git \
    htop \
    jq \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libfreetype6 \
    libgbm1 \
    libharfbuzz0b \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxtst6 \
    lsof \
    make \
    mount \
    openssl \
    procps \
    python3 \
    sqlite3 \
    sudo \
    util-linux \
    unzip \
    uuid-runtime \
    vim \
    wget \
    xclip \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy bun binary from builder instead of re-installing
COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# Install assistant CLI launcher backed by the bundled assistant package
RUN printf '#!/usr/bin/env sh\nexec bun run /app/assistant/src/index.ts "$@"\n' > /usr/local/bin/assistant && \
    chmod +x /usr/local/bin/assistant

# The unprivileged identity the daemon drops to when
# CUE_DROP_DAEMON_PRIVILEGES=1 (see docker-cue-app-entrypoint.sh). Every shell
# command the agent runs inherits it.
#
# No sudoers entry: passwordless sudo here would hand the whole privilege drop
# back with one word, so the daemon could reach the gateway's trust material
# again and the control would be decorative. If a skill genuinely needs a
# system package, that is a deliberate image change, not something an
# agent-authored command grants itself at runtime.
RUN groupadd --system --gid 1001 assistant && \
    useradd --system --uid 1001 --gid assistant --create-home --shell /bin/bash assistant

# Set up assistant home directory for local state (device.json, etc.)
RUN mkdir -p /home/assistant/.vellum && \
    chown -R assistant:assistant /home/assistant/.vellum

# Update PATH for assistant user
ENV PATH="/home/assistant/.bun/bin:${PATH}"

# Configure package managers to use assistant home
ENV BUN_INSTALL="/home/assistant/.bun"
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
ENV PYTHONUSERBASE="/home/assistant/.python"
ENV PATH="${PYTHONUSERBASE}/bin:${PATH}"

RUN printf '%s\n' \
    'if [ -r /app/assistant/docker-kata-apt-env.sh ]; then' \
    '  . /app/assistant/docker-kata-apt-env.sh' \
    'fi' \
    > /etc/profile.d/vellum-kata-apt-root.sh && \
    printf '%s\n' \
    '' \
    'if [ -r /etc/profile.d/vellum-kata-apt-root.sh ]; then' \
    '  . /etc/profile.d/vellum-kata-apt-root.sh' \
    'fi' \
    >> /etc/bash.bashrc && \
    printf '%s\n' \
    '' \
    'if [ -r /etc/profile.d/vellum-kata-apt-root.sh ]; then' \
    '  . /etc/profile.d/vellum-kata-apt-root.sh' \
    'fi' \
    >> /root/.bashrc && \
    printf '%s\n' \
    '' \
    'if [ -r /etc/profile.d/vellum-kata-apt-root.sh ]; then' \
    '  . /etc/profile.d/vellum-kata-apt-root.sh' \
    'fi' \
    >> /home/assistant/.bashrc && \
    chown assistant:assistant /home/assistant/.bashrc

RUN printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    '. /app/assistant/docker-kata-runtime-family.sh' \
    'if ! vellum_is_kata_family_runtime; then' \
    '  exec /usr/bin/apt-get "$@"' \
    'fi' \
    'export DEBIAN_FRONTEND=noninteractive' \
    'DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"' \
    '/app/assistant/docker-init-apt-root.sh' \
    'if [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/apt-get" ] && [ -f "${DATA_ROOT}/.rootfs-initialized" ] && ! grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts; then' \
    '  exec chroot "${DATA_ROOT}" /usr/bin/apt-get "$@"' \
    'fi' \
    'exec /usr/bin/apt-get "$@"' \
    > /usr/local/bin/apt-get && \
    chmod +x /usr/local/bin/apt-get && \
    printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    '. /app/assistant/docker-kata-runtime-family.sh' \
    'if ! vellum_is_kata_family_runtime; then' \
    '  exec /usr/bin/apt "$@"' \
    'fi' \
    'export DEBIAN_FRONTEND=noninteractive' \
    'DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"' \
    '/app/assistant/docker-init-apt-root.sh' \
    'if [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/apt" ] && [ -f "${DATA_ROOT}/.rootfs-initialized" ] && ! grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts; then' \
    '  exec chroot "${DATA_ROOT}" /usr/bin/apt "$@"' \
    'fi' \
    'exec /usr/bin/apt "$@"' \
    > /usr/local/bin/apt && \
    chmod +x /usr/local/bin/apt && \
    printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    '. /app/assistant/docker-kata-runtime-family.sh' \
    'if ! vellum_is_kata_family_runtime; then' \
    '  exec /usr/bin/dpkg "$@"' \
    'fi' \
    'DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"' \
    '/app/assistant/docker-init-apt-root.sh' \
    'if [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/dpkg" ] && [ -f "${DATA_ROOT}/.rootfs-initialized" ] && ! grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts; then' \
    '  exec chroot "${DATA_ROOT}" /usr/bin/dpkg "$@"' \
    'fi' \
    'exec /usr/bin/dpkg "$@"' \
    > /usr/local/bin/dpkg && \
    chmod +x /usr/local/bin/dpkg

# Ensure the CES bootstrap socket volume is writable by the non-root CES user.
RUN mkdir -p /run/ces-bootstrap && chmod 777 /run/ces-bootstrap

USER root

EXPOSE 3001

ENV RUNTIME_HTTP_PORT=3001
ENV IS_CONTAINERIZED=true

# Copy installed deps, shared packages, bundled skills, assistant source,
# and the generated meet-join manifest from the builder stage.
COPY --from=builder /app /app

# Self-hosted web client: the pre-built SPA the gateway serves under
# /assistant/* (via WEB_DIST_DIR). Committed under deploy/web-dist so there's no
# in-image web build; rebuilt + recommitted on web changes. Harmless on deploys
# that don't set WEB_DIST_DIR.
COPY deploy/web-dist /app/web-dist

# Bake Playwright's Chromium into the image.
#
# Without this the FIRST browser call in a fresh container blocks on a runtime
# `playwright install chromium` (622 MB on disk). Measured on prod 2026-07-22: a single
# `browser navigate` took 114,135 ms, of which almost all was this download —
# confirmed by the install landing in /root/.cache/ms-playwright inside the
# navigate's window. The system libraries Chromium needs are already installed
# in this stage, so `--with-deps` (which would go through the kata apt shim) is
# not used. PLAYWRIGHT_BROWSERS_PATH pins the location so the daemon finds the
# baked copy regardless of which user it runs as.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd /app/assistant && bunx playwright install chromium && \
    chmod -R a+rX /ms-playwright

COPY packages/block-volume-bootstrap/scripts/*.sh /usr/local/bin/

RUN chmod +x \
    /app/assistant/docker-entrypoint.sh \
    /app/assistant/docker-cue-app-entrypoint.sh \
    /app/assistant/docker-init-apt-root.sh \
    /app/assistant/docker-kata-apt-env.sh \
    /app/assistant/docker-kata-runtime-family.sh \
    /usr/local/bin/vellum-block-volume-common.sh \
    /usr/local/bin/vellum-block-volume-init.sh \
    /usr/local/bin/vellum-block-volume-mount.sh \
    /usr/local/bin/vellum-block-volume-resize.sh

# Run the daemon + http server
CMD ["/app/assistant/docker-entrypoint.sh"]
