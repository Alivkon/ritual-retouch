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
- Traefik автоматически выдаёт TLS и роутит трафик на `imagetransformation.ru`
