# agent 服务（LLM 编排 / 工具 / MCP / 记忆）—— 端口 8766
#
# 构建：docker build -f agent/Dockerfile -t nexus-agent .

FROM node:22-slim

# pnpm 用 corepack 拿，版本跟仓库里的 lock 走
RUN corepack enable

WORKDIR /app

COPY agent/package.json agent/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY agent/ ./

# ★ 用 `tsx` 直接跑 TS 源码，不预编译。
#
# 理由是启动快：这个服务每次改配置都会重启，而 `tsc` 要几秒。
# 代价是镜像里带着 tsx 和源码 —— 对一个本地伴侣应用来说这个交换划算。
ENV NODE_ENV=production \
    AGENT_PORT=8766 \
    AGENT_DATA_DIR=/app/data

# 记忆 / 转录 / 摘要都落在这里。**必须挂载**，否则容器一删记忆就没了。
VOLUME ["/app/data"]

EXPOSE 8766

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8766/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
