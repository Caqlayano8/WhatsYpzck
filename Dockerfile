FROM node:slim AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    --no-install-recommends \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install && npm cache clean --force

COPY . .

RUN npm run build

# --- Production stage ---
FROM node:slim

RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    nano \
    zip unzip \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    chromium \
    --no-install-recommends \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production && npm cache clean --force

COPY --from=builder /app/build ./build
COPY --from=builder /app/build/public ./public
COPY --from=builder /app/licenses ./licenses

EXPOSE 3000

CMD ["node", "build/index.js"]