FROM oven/bun:1-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY broker.ts ./
COPY shared/ ./shared/

# SQLite data directory (mount a volume here for persistence)
RUN mkdir -p /data && chown bun:bun /data
ENV CLAUDE_PEERS_DB=/data/claude-peers.db

USER bun
EXPOSE 7899
CMD ["bun", "broker.ts"]
