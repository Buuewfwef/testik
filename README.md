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

Прогнать всё: `npm test` (этап 1 + этап 2)

---

## этап 1 — заказ и выдача

Один товар:

```
curl -s -X POST localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"sku":"STEAM-TOPUP-500"}'
```

Несколько товаров (этап 2):

```
curl -s -X POST localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"items":[{"sku":"STEAM-TOPUP-500"},{"sku":"KEY-CS2-PRIME"}]}'
```

Оплата (amount = сумма всех позиций):

```
curl -s -X POST localhost:3000/webhook/payment \
  -H 'content-type: application/json' \
  -d '{
    "event_id":"evt_1",
    "order_id":"ord_XXXX",
    "status":"paid",
    "amount":1790,
    "currency":"RUB",
    "created_at":"2025-01-01T12:00:00Z"
  }'
```

Статус заказа:

```
curl -s localhost:3000/api/orders/ord_XXXX
```

В ответе `items[]` — каждая позиция со своим статусом и кодом.

### гонка вебхуков

```
npm run race
```

### таймаут и fallback A→B

```
npm run fallback
```

Режимы поставщика:

```
curl -s -X POST localhost:3000/internal/suppliers/A/behavior \
  -H 'content-type: application/json' \
  -d '{"mode":"always_timeout"}'
```

`normal`, `always_timeout`, `always_unavailable`, `always_out_of_stock`, `random`.

### сверка и каталог

```
curl -s localhost:3000/api/admin/reconciliation
curl -s "localhost:3000/api/catalog?limit=20"
```

---

## этап 2 — мульти-заказ, злой поставщик, очередь

### задача 1 — частичная выдача и возврат

```
npm run partial
```

или вручную: B в режиме `always_out_of_stock`, заказ из двух sku (Steam у A, CS2 у B).
Ожидание: `partially_fulfilled`, один код, деньги сходятся.

Проверка денег по заказу:

```
curl -s localhost:3000/api/admin/orders/ord_XXXX/money
```

`paid = delivered + refunded`, `balanced: true`.

### задача 2 — поставщику нельзя доверять

```
npm run evil
```

Режимы:

| mode | что делает |
|------|------------|
| `wrong_code` | ответил фейковый код, в БД другой — берём из `supplier_issues` |
| `error_after_issue` | 503 после выдачи — повтор не дублирует |
| `duplicate_code` | пытается отдать чужой код — отклоняем, свой код из peek |

Повтор `retry` / вебхука / джобы — без лишних выдач и возвратов (см. тесты).

### задача 3 — лимит поставщика (бонус)

```
curl -s localhost:3000/api/admin/queue
```

Показывает: jobs в очереди, выданные заказы, `used/limit` по A и B.
Лимит: `SUPPLIER_A_RPM`, `SUPPLIER_B_RPM` (по умолчанию 30/мин).
Оплаченные джобы priority=10, неоплаченные (priority=0) пропускаются.

### задача 4 — состояние на дату (бонус)

```
curl -s "localhost:3000/api/admin/orders/ord_XXXX/at?ts=2025-01-01T12:00:00.000Z"
curl -s "localhost:3000/api/admin/ledger/period?from=...&to=..."
```

История в `order_events` — только append, без переписывания.

---

## как сделано

- **Позиции заказа** — `order_line_items`, у каждого свой поставщик из каталога
- **Деньги** — двойная запись: payment → deferred, delivery → revenue, refund → cash
- **Идемпотентность** — `event_id`, `request_id = order:line:supplier`, unique на delivery.code
- **Поставщик** — ответу не верим, источник правды `supplier_issues` + peek при любой ошибке
- **Очередь** — postgres jobs, SKIP LOCKED, priority, rate limiter на вызов supplier
- **События** — append-only `order_events` для replay на дату

Время: этап 1 ~3ч, этап 2 ~4ч.
