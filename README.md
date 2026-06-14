# ImageTransformationTGBot-TS

## Пробный запуск (локально через Yarn)

```bash
cd /opt/bots/ImageTransformationTGBot-TS

# 1. Создать .env с необходимыми переменными
cp .env.example .env   # если есть шаблон, иначе создать вручную

# 2. Установить зависимости
yarn install

# 3. Собрать TypeScript → JS
yarn build

# 4. Запустить
yarn start
```

> **Важно:** для пробного запуска нужна PostgreSQL, прописанная в `.env`.

Альтернатива — режим разработки без компиляции:
```bash
yarn dev
```

---

## Локальная разработка (Docker Compose)

Поднимает PostgreSQL + бот локально, без Traefik и внешних сетей.

```bash
# 1. Создать .env из шаблона
cp .env.example .env
# Заполнить BOT_TOKEN, KIE_API_KEY, POSTGRES_PASSWORD и остальные переменные

# 2. Собрать и запустить
docker compose -f docker-compose.dev.yml up -d --build

# 3. Сервис доступен на http://localhost:8080

# Пересборка после изменений кода:
docker compose -f docker-compose.dev.yml build bot && docker compose -f docker-compose.dev.yml up -d bot

# Логи:
docker compose -f docker-compose.dev.yml logs -f bot

# Остановить:
docker compose -f docker-compose.dev.yml down
```

> **Примечание:** `WEBAPP_URL` автоматически переопределяется на `http://localhost:8080` в dev-режиме.
> Таблицы БД создаются автоматически при первом старте.

---

## Продакшн-деплой (Docker Compose на сервере)

```bash
cd /opt/bots/ImageTransformationTGBot-TS

# 1. Создать/проверить .env
nano .env
# Нужные переменные: BOT_TOKEN, POSTGRES_PASSWORD и другие по конфигу

# 2. Собрать и поднять контейнеры
docker compose up -d --build

docker compose build bot && docker compose up -d bot

# 3. Проверить статус
docker compose ps
docker compose logs -f bot
```

После запуска:
- Бот работает в контейнере `imagetransformationtgbot_ts`
- PostgreSQL — в контейнере `postgre_imagetransformer`
- Traefik автоматически выдаёт TLS и роутит трафик на `ritual-retouch.ru`
