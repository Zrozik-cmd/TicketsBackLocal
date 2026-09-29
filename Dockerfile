# -----------------------
# Этап 1: сборка приложения
# -----------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Копируем только package.json и lock-файл для установки зависимостей
COPY package*.json ./

# Устанавливаем все зависимости (включая dev) для сборки
RUN npm ci

# Копируем весь исходный код и собираем проект
COPY . .
RUN npm run build

# -----------------------
# Этап 2: финальный продакшн-образ
# -----------------------
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Копируем только production-зависимости из builder
COPY package*.json ./
RUN npm ci --production

# Копируем собранную папку dist из builder
COPY --from=builder /app/dist ./dist

# Запуск приложения
CMD ["node", "dist/main.js"]