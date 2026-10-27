# MANI — сервис онлайн-записи

Учебный проект салона маникюра: Node.js API, SQLite и отдельный черновой интерфейс для ручной проверки. Исходный дизайн-прототип в корне (`index.html`, `styles.css`, `app.js`) не изменяется.

## Требования

- Node.js 24.x (используется встроенный `node:sqlite`).
- npm входит в дистрибутив Node.js.
- Внешние npm-зависимости не требуются.

## Локальный запуск

1. Откройте командную строку в папке проекта.
2. Убедитесь, что `node --version` показывает v24.x. Если используется ZIP-версия Node без установки и PATH, из командной строки можно временно добавить распакованную папку:

   ```cmd
   set "PATH=C:\путь\к\распакованному\node-v24;%PATH%"
   ```

3. Создайте локальный файл настроек из `.env.example` (если значения по умолчанию подходят, шаг можно пропустить).
4. Создайте таблицы и примените миграции:

   ```cmd
   npm run db:migrate
   ```

5. Добавьте тестовые данные:

   ```cmd
   npm run db:seed
   ```

6. Запустите сервер:

   ```cmd
   npm start
   ```

7. Откройте `http://localhost:3000/draft/`.

Базу можно полностью создать заново командами `npm run db:reset` и `npm run db:seed`. Файл SQLite появится в `.data/mani.sqlite` и исключён из Git.

## Тестовые аккаунты

| Роль | Email | Пароль |
|---|---|---|
| Администратор | `admin@mani.local` | `AdminDemo!24` |
| Мастер и администратор | `alina@mani.local` | `MasterDemo!24` |
| Мастер | `vera@mani.local` | `MasterDemo!24` |
| Клиент | `client@mani.local` | `ClientDemo!24` |

Тестовые пароли предназначены только для локальной разработки. Скрипт `npm run db:seed` сообщает эти данные в терминал.

## API

- `POST /api/auth/register`, `/api/auth/login`, `/api/auth/logout`
- `GET /api/services`, `/api/masters`
- `GET /api/masters/:id/slots?date=YYYY-MM-DD&serviceIds=1,2`
- `POST /api/holds`, `POST /api/appointments`
- `GET /api/appointments/my`, `GET /api/appointments/:id`
- `PATCH /api/appointments/:id`, `POST /api/appointments/:id/cancel`
- `GET /api/admin/appointments`
- `POST /api/admin/appointments`, `/api/admin/services`, `/api/admin/masters`, `/api/admin/time-blocks`
- `GET /api/admin/masters`; `PATCH`/`DELETE /api/admin/services/:id` и `/api/admin/masters/:id`
- `PUT /api/admin/masters/:id/services`, `POST /api/admin/masters/:id/schedules`, `PATCH /api/admin/settings`

Защищённые запросы используют `Authorization: Bearer <token>`. Схема БД описана в [`docs/db-schema.md`](docs/db-schema.md); технические решения и известные ограничения — в [`docs/DEVELOPMENT_LOG.md`](docs/DEVELOPMENT_LOG.md).

## Данные и безопасность

Пароли хешируются `scrypt` с индивидуальной солью, токены хранятся в БД только в виде SHA-256-хешей. Включены внешние ключи SQLite, параметризованные SQL-запросы, серверные проверки ролей и принадлежности записей, ограничение частоты неудачных входов и триггеры против пересечения записей. Локальная база, `.env` и `node_modules` не должны попадать в репозиторий.

Перед деплоем нужно подтвердить доступную на хостинге версию Node.js 24.x и наличие постоянного локального диска для SQLite. Совместимость с конкретным тарифом BeGet в этой среде не проверялась.

## Production-развёртывание

Для Coolify используется `Dockerfile` с Node.js 24. При запуске контейнера автоматически применяются миграции, но демонстрационные данные не создаются.

- Создайте постоянное хранилище и подключите его к контейнеру по пути `/data`.
- Оставьте `DATABASE_PATH=/data/mani.sqlite` или задайте другой путь внутри постоянного хранилища.
- В Coolify укажите внутренний порт приложения `3000` и домен `https://mani-test.ru`.
- В Coolify задайте `ADMIN_EMAIL`, `ADMIN_PASSWORD` (минимум 10 символов) и при необходимости `ADMIN_NAME`. При первом запуске эти переменные создадут администратора; пароль не попадёт в БД в открытом виде, Git или журналы.
- Не запускайте `npm run db:seed` в production: он создаёт публично известные демонстрационные учётные записи.
