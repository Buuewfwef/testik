# магазин ключей

Тестовое. Nest, Postgres.

Эквайринга нет — вебхук шлём сами. Поставщики тоже заглушки.

## запуск

```
docker compose up -d
npm i
npx prisma generate
npm run db:setup
npm run start:dev
```

http://localhost:3000

Прогнать всё: `npm test`

Ниже сервер уже должен работать.

## этап 1 — заказ и выдача

Создать заказ:

```
curl -s -X POST localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"sku":"STEAM-TOPUP-500"}'
```

Вернётся `id` вроде `ord_...`, статус `created`.

Оплата (свой id и amount из ответа):

```
curl -s -X POST localhost:3000/webhook/payment \
  -H 'content-type: application/json' \
  -d '{
    "event_id":"evt_1",
    "order_id":"ord_XXXX",
    "status":"paid",
    "amount":500,
    "currency":"RUB",
    "created_at":"2025-01-01T12:00:00Z"
  }'
```

Посмотреть:

```
curl -s localhost:3000/api/orders/ord_XXXX
```

Ждём `delivered` и ключ в `code`.

## этап 2 — гонка

```
npm run race
```

50 вебхуков paid на один заказ. Должен уйти один ключ.

Повтор с тем же `event_id` проверяется в `npm test`.

## этап 3 — таймаут и запасной поставщик

```
npm run fallback
```

Сначала A зависает (ключ уже выдан, второй не берём).
Потом A лежит — выдаёт B.

Вручную сломать A:

```
curl -s -X POST localhost:3000/internal/suppliers/A/behavior \
  -H 'content-type: application/json' \
  -d '{"mode":"always_timeout"}'
```

Ещё есть `always_unavailable`, `always_out_of_stock`, `random`.
Потом заказ + оплата как в этапе 1. Потом верни `normal`.

## этап 4 — сверка

```
curl -s localhost:3000/api/admin/reconciliation
```

Списки: оплачен без ключа / ключ без оплаты. Касса — поле `ledger.balanced`.

Зависшие добить:

```
curl -s -X POST localhost:3000/api/admin/reconciliation/run
```

Если ключей нет — будет `out_of_stock`, это ок. Положить ключ и повторить:

```
curl -s -X POST localhost:3000/api/admin/inventory/replenish \
  -H 'content-type: application/json' \
  -d '{"sku":"STEAM-TOPUP-500","codes":["TEST-KEY-0001"]}'

curl -s -X POST localhost:3000/api/admin/orders/ord_XXXX/retry
```

Раз в 5 секунд то же самое делает фон.

## этап 5 — каталог

В сиде ~5000 sku.

```
curl -s "localhost:3000/api/catalog?limit=20"
curl -s localhost:3000/api/catalog/explain
```

В explain не должно быть seq scan по всей таблице.

## как сделано

Вебхук сразу 200, выдача через очередь в postgres.

Заказы не пересекаются: лок по order_id. event_id уникальный.

Поставщику всегда тот же request_id. Завис — не значит «не выдал», на B не прыгаем.
B только если A точно не взял ключ.

Нет ключей — out_of_stock, заказ не умирает.

Масштаб: несколько api, очередь выдачи отдельно, витрину в кэш.

~3 часа.
