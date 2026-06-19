FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8788

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY openapi.codexlink.relay.gpt-actions.json ./openapi.codexlink.relay.gpt-actions.json

USER node

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/relay/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["sh", "-c", "exec node dist/cli.js relay hosted serve --host 0.0.0.0 --port \"$PORT\" --public-url \"${CODEXLINK_PUBLIC_URL:-auto}\""]
