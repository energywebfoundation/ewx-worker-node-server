FROM node:18.19-alpine as base
WORKDIR /app

FROM base as builder-base
RUN apk add --no-cache python3 py3-pip make g++

FROM builder-base as builder

COPY ["package.json", "package-lock.json", ".npmrc", ".nvmrc", "./"]

RUN \
    --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .

RUN npm run build

FROM base as runner

ENV NODE_ENV=production
ENV NO_COLOR=true

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./

ARG GIT_SHA
ARG VERSION
RUN echo "{\"timestamp\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\", \"gitSha\": \"$GIT_SHA\", \"version\": \"$VERSION\"}" > build.json

RUN chown -R node:node /app
USER node

CMD ["node", "--enable-source-maps", "main.js"]

EXPOSE 3000
