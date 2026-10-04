# LeadForge AI - Node/Express API
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# Install production dependencies first for layer caching.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY . .

# The app never writes to disk; run as an unprivileged user.
RUN addgroup -S leadforge && adduser -S leadforge -G leadforge \
    && chown -R leadforge:leadforge /app
USER leadforge

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]