# Cue HQ — control plane + marketing/commerce site, one container.
# Build context is the REPO ROOT (the image needs both hq/ and site/):
#   flyctl deploy --config hq/fly.toml --dockerfile hq/Dockerfile .
# Persistent state is a single SQLite file — mount a volume at /data
# (HQ_DB_PATH=/data/hq.db). The static site ships inside the image at
# /app/site (HQ_SITE_DIR); redeploying the image is how the site updates.
FROM oven/bun:1.2-slim

WORKDIR /app/hq
COPY hq/package.json hq/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY hq/src ./src
COPY hq/tsconfig.json ./
COPY site /app/site

ENV HQ_DB_PATH=/data/hq.db \
    HQ_SITE_DIR=/app/site \
    HQ_PORT=8790

EXPOSE 8790
CMD ["bun", "run", "src/server.ts"]
