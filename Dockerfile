# a8-claw — Per-Session Sandboxed Conversational Agent Runtime
# Mirrors a8-code's deployment pattern: pod-per-session, single image with
# everything baked in (no host bind-mounts), runs the agent-runner directly
# as the pod's main process. Each pod is a session.
#
# Mission intake: the pod polls Warp's queue API for agent_execute_a8_claw
# messages (same pattern as a8-code/src/main.ts:101). When a message
# arrives, the pod spawns one nanoclaw session, processes the conversation,
# publishes to mission_completions, returns to the warm pool.
#
# Inference: ALL model calls route through Model Manager (RUNTIME_CONTRACT
# §7); api.anthropic.com is blocked at the NetworkPolicy layer + the
# runtime egress allowlist (src/auth/egress-allowlist.ts).

# ── Base image ────────────────────────────────────────────────────────
FROM node:22-slim AS base
ARG TARGETARCH

# System deps — curl/git for diagnostics, tini for proper signal handling.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    jq \
    tini \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (host code uses pnpm); Bun for the agent-runner
# (container/agent-runner/* is a bun package, separate dep tree).
ARG BUN_VERSION=1.3.12
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
RUN mkdir -p "$PNPM_HOME/bin" && corepack enable
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    mv ~/.bun/bin/bun /usr/local/bin/bun && \
    chmod +x /usr/local/bin/bun

# Claude Code CLI for the agent-runner (pinned per local container/Dockerfile)
ARG CLAUDE_CODE_VERSION=2.1.116
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
RUN INSTALL_CJS=$(find /pnpm/store -name install.cjs -path '*@anthropic-ai/claude-code*' | head -1) && \
    test -f "$INSTALL_CJS" && \
    cd "$(dirname "$INSTALL_CJS")" && \
    node install.cjs

# ── App layout ────────────────────────────────────────────────────────
WORKDIR /app

# Host (nanoclaw) dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Agent-runner dependencies (separate tree, bun)
COPY container/agent-runner/package.json container/agent-runner/bun.lock ./container/agent-runner/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    cd /app/container/agent-runner && bun install --frozen-lockfile

# Bake in EVERYTHING the pod needs:
#   - src/                     host (nanoclaw daemon, channel adapters, runtime)
#   - container/agent-runner/  per-session agent code (bundled in same pod, NOT a separate container)
#   - container/skills/        skills mounted into agent sessions
#   - container/CLAUDE.md      shared base prompt
#   - registry/                extension registry (Notion, channels, etc.)
#   - .platform-mcp-build/     platform-mcp library (copied from ../platform-mcp/ by build-and-deploy.sh)
COPY . /app/

# platform-mcp library lives in agentmesh sibling dir. The build-and-deploy
# script copies it into .platform-mcp-build/ before `docker build` so the
# image can include it without a parent-context build.
COPY .platform-mcp-build/ /app/platform-mcp/

# Build the host TypeScript so the pod can run dist/cloud-main.js directly.
# Agent-runner source is consumed at runtime by bun (no separate build).
RUN pnpm run build || (echo "TypeScript build failed" && exit 1)

# Non-root user, owns app dir + scratch
RUN useradd -m -s /bin/bash a8user && \
    mkdir -p /workspace /home/a8user/.claude && \
    chown -R a8user:a8user /app /workspace /home/a8user

USER a8user

# Health check — pod-mode entry exposes :8040/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8040/health || exit 1

EXPOSE 8040

# Entry — runs the pod-mode main loop (queue consumer + session orchestrator).
# tini handles PID 1 signal forwarding so SIGTERM properly graceful-shuts
# the queue loop instead of being orphaned.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cloud-main.js"]
