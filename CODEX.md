# ImageTransformationTGBot-TS
TypeScript-версия бота для трансформации изображений для ритуальной обработки.

После каждой задачи с изменениями проекта создавайте отдельный отчёт на русском
языке в `docs/` по правилам [AGENTS.md](AGENTS.md).

Вся сборка и запуск пакетов делаются через `yarn`:

```bash
yarn install
yarn build
yarn start
```
Всегда после изменения кода, для перезапуска бота используй:

```bash
sudo docker compose build bot && docker compose up -d bot
```
