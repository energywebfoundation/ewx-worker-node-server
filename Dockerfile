FROM node:22.21.1-alpine AS base
WORKDIR /app

FROM base AS builder-base
RUN apk add --no-cache python3 py3-pip make g++

FROM builder-base AS builder

COPY ["package.json", "package-lock.json", ".npmrc", ".nvmrc", "./"]

RUN \
    --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .

RUN npm run build

FROM base AS runner

ENV NODE_ENV=production
ENV NO_COLOR=true

COPY --from=builder --chown=node:node  /app/node_modules ./node_modules
COPY --from=builder --chown=node:node  /app/dist ./

ARG GIT_SHA
ARG VERSION
RUN echo "{\"timestamp\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\", \"gitSha\": \"$GIT_SHA\", \"version\": \"$VERSION\"}" > build.json

USER node

CMD ["node", "--enable-source-maps", "main.js"]

EXPOSE 3000
