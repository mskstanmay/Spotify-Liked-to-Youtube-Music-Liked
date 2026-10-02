# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS node-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npm run db:generate


FROM node:22-bookworm-slim AS worker

ENV NODE_ENV=production \
    PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-pip \
        python3-venv \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --from=node-build /app/node_modules/.prisma ./node_modules/.prisma

COPY requirements.txt ./
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /app/.venv/bin/python -m pip install --no-cache-dir -r requirements.txt \
    && test -x /app/.venv/bin/python \
    && /app/.venv/bin/python -c "import ytmusicapi; print(ytmusicapi.__version__)"

COPY prisma ./prisma
COPY src ./src

USER node

ENTRYPOINT ["tini", "--"]
CMD ["npm", "run", "worker"]
