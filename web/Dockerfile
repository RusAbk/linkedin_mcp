FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npx playwright install --with-deps chrome \
    && apt-get update && apt-get install -y --no-install-recommends xvfb xauth tini \
    && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build --prefix web && mkdir -p /data && chown node:node /data
ENV WEB_HOST=0.0.0.0 WEB_PORT=3000 WEB_DATA_DIR=/data LINKEDIN_HEADLESS=false LINKEDIN_BROWSER_CHANNEL=chrome
USER node
WORKDIR /app/web
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1440x1000x24 -nolisten tcp", "node", "dist/web/src/main.js"]
