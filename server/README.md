# VK Reposter Server 4.4.0

Сервер выполняет отложенные посты, комментарии и Истории с одним
пользовательским токеном. Токен принимается только через защищённый API и
хранится в MongoDB как AES-256-GCM-шифротекст (`ciphertext`, `iv`, `tag`). В
ответах API и логах токен отсутствует.

## 1. MongoDB Atlas

1. Создайте кластер и отдельного Database User.
2. В **Network Access** разрешите подключение из региона Render.
3. Получите Node.js connection string и добавьте базу `vk_reposter_safe`:

```text
mongodb+srv://USER:PASSWORD@CLUSTER/vk_reposter_safe?retryWrites=true&w=majority
```

Спецсимволы пароля должны быть URL-encoded. Коллекции постов, комментариев и
Историй, индексы и TTL создаются приложением автоматически.

## 2. Секреты

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

- первая строка — `API_SECRET` (не короче 32 символов);
- вторая строка — `TOKEN_ENCRYPTION_KEY` (ровно 32 байта в base64).

Не меняйте `TOKEN_ENCRYPTION_KEY`, пока в MongoDB есть активные задания: новый
ключ не расшифрует уже созданные записи.

## 3. Render

Через **New → Blueprint** выберите репозиторий с `render.yaml` либо создайте Web
Service вручную:

```text
Build Command: cd server && npm ci
Start Command: cd server && npm start
Health Check Path: /health
```

Environment Variables:

```text
MONGODB_URI=...
API_SECRET=...
TOKEN_ENCRYPTION_KEY=...
WORKER_INTERVAL_MS=15000
POST_GROUP_INTERVAL_MS=15000
STALE_LOCK_MS=600000
VK_API_VERSION=5.199
STORY_MAX_BYTES=26214400
```

Для выполнения заданий при выключенном компьютере сервис должен быть always-on.
`render.yaml` использует `starter`. На засыпающем web service процесс и таймеры
не работают до следующего входящего запроса.

После деплоя:

```json
{"status":"ok","version":"4.4.0","database":"connected"}
```

Корневой URL намеренно возвращает `{"ok":false,"error":"Not found"}`; это не
ошибка соединения. Проверять нужно маршрут `/health`.

## 4. Расширение

1. Подключите пользовательский токен VK.
2. Обновите список администрируемых сообществ.
3. Укажите Render URL и `API_SECRET`.
4. Нажмите **Сохранить и проверить**.

Отдельные токены сообществ в версии 4.6.0 не настраиваются. Пост, комментарий и
История получают пользовательский токен при создании задания; MongoDB видит
только его шифротекст.

## 5. Как исполняется пост

1. `POST /api/scheduled-posts` сохраняет источник, паблики, время и шифротекст.
2. Worker атомарно берёт одно просроченное задание.
3. В момент выхода он вызывает `wall.getById`, скачивает фото по разрешённым VK
   HTTPS-хостам, загружает их через `photos.getWallUploadServer` и
   `photos.saveWallPhoto` в целевой паблик.
4. `wall.post` вызывается без `publish_date`, поэтому дата медиа не предшествует
   фактическому выходу записи.
5. Следующий паблик обрабатывается после настроенного интервала, минимум 15 с.
6. Комментарий создаётся отдельным серверным заданием с тем же user token.

Пока worker не взял соответствующую цель, интерфейс использует:

- `PATCH /api/scheduled-posts/:id` — текст, режим, автокомментарий и время;
- `DELETE /api/scheduled-posts/:id/groups/:groupId` — пропустить один паблик;
- `PATCH /api/scheduled-comments/:id` — текст и время комментария.

Уже опубликованные цели остаются неизменными; отменённый паблик worker отмечает
отдельным результатом и не вызывает для него VK API.

## 6. Очистка MongoDB

На странице **Публикации и отложка → Очистка данных** доступны режимы:

- только ошибки;
- только успешно завершённые;
- вся завершённая история.

Активные, ожидающие и приостановленные задания сохраняются. Медиа Историй также
удаляются из GridFS. TTL дополнительно удаляет старые завершённые документы.

## 7. Локальная проверка

```powershell
cd server
npm ci
npm test
npm run check
```

При CAPTCHA, validation, flood-control или suspicious activity worker ставит
задание на паузу. После ручной проверки VK используйте **Повторить**.
