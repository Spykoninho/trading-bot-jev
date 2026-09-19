FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0
EXPOSE 3210
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s CMD wget -qO- http://127.0.0.1:3210/api/state >/dev/null || exit 1
CMD ["node_modules/.bin/tsx", "src/index.ts"]
