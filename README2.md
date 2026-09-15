# этап 2 — как воспроизвести

Репозиторий: https://github.com/Buuewfwef/testik

## подготовка

```
docker compose up -d
npm i
npm run db:setup
npm run start:dev
```

Сервер: http://localhost:3000

---

## частичный сбой заказа

Часть товаров выдаётся, за невыданные — возврат. Деньги сходятся: `оплачено = выдано + возвращено`.

### скрипт

```
npm run partial
```

Ожидание:
- статус `partially_fulfilled`
- Steam — `delivered` + код
- CS2 — `refunded`
- `paid = delivered + refunded`

### вручную

**1.** Сломать поставщика B (CS2 идёт через B):

```
curl -s -X POST localhost:3000/internal/suppliers/B/behavior \
  -H 'content-type: application/json' \
  -d '{"mode":"always_out_of_stock"}'
```

**2.** Заказ из двух позиций:

```
curl -s -X POST localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"items":[{"sku":"STEAM-TOPUP-500"},{"sku":"KEY-CS2-PRIME"}]}'
```

Запомни `id` и `amount` (1790).

**3.** Оплата:

```
curl -s -X POST localhost:3000/webhook/payment \
  -H 'content-type: application/json' \
  -d '{
    "event_id":"evt_partial_1",
    "order_id":"ord_XXXX",
    "status":"paid",
    "amount":1790,
    "currency":"RUB",
    "created_at":"2025-01-01T12:00:00Z"
  }'
```

**4.** Статус (повторяй, пока не `partially_fulfilled`):

```
curl -s localhost:3000/api/orders/ord_XXXX
```

**5.** Проверка денег:

```
curl -s localhost:3000/api/admin/orders/ord_XXXX/money
```

Должно быть: `paid: 1790`, `delivered: 500`, `refunded: 1290`, `balanced: true`.

**6.** Идемпотентность — повторный retry не создаёт лишних выдач и возвратов:

```
curl -s -X POST localhost:3000/api/admin/orders/ord_XXXX/retry
```

---

## недобросовестный поставщик

Ответу поставщика не верим. Источник правды — `supplier_issues` в БД.

### скрипт

```
npm run evil
```

По очереди: `wrong_code`, `error_after_issue`, `duplicate_code`. Каждый раз один код, без дубля.

### вручную

| режим | что делает поставщик | что должно получиться |
|-------|----------------------|------------------------|
| `wrong_code` | ответил фейковый код | выдали реальный из БД |
| `error_after_issue` | 503 после выдачи | повтор без второй выдачи |
| `duplicate_code` | пытается отдать чужой код | свой код, дубль отклонён |

**wrong_code:**

```
curl -s -X POST localhost:3000/internal/suppliers/A/behavior \
  -H 'content-type: application/json' \
  -d '{"mode":"wrong_code"}'

curl -s -X POST localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"sku":"STEAM-TOPUP-500"}'

curl -s -X POST localhost:3000/webhook/payment \
  -H 'content-type: application/json' \
  -d '{
    "event_id":"evt_evil",
    "order_id":"ord_XXXX",
    "status":"paid",
    "amount":500,
    "currency":"RUB",
    "created_at":"2025-01-01T12:00:00Z"
  }'

curl -s localhost:3000/api/orders/ord_XXXX
```

Код будет настоящий, не `FAKE-CODE-EVIL`.

**error_after_issue** — то же, `"mode":"error_after_issue"`. Заказ всё равно `delivered`, в БД одна запись в `supplier_issues`.

**duplicate_code** — два заказа подряд с `"mode":"duplicate_code"`. У каждого свой код.

---

## как проверить, что деньги сходятся

Главное правило: **оплачено = выдано + возвращено**.

### 1. по одному заказу

После оплаты и выдачи (или частичной выдачи):

```
curl -s localhost:3000/api/admin/orders/ord_XXXX/money
```

Пример ответа:

```json
{
  "paid": 1790,
  "delivered": 500,
  "refunded": 1290,
  "balanced": true
}
```

Смотри:
- `paid = delivered + refunded`
- `balanced: true`

Если всё выдали: `refunded: 0`, `paid = delivered`.
Если частично: одна позиция `delivered`, другая `refunded`.

После `npm run partial` скрипт сам печатает блок `деньги` — там тоже должно быть `balanced: true`.

### 2. общая касса (все заказы)

```
curl -s localhost:3000/api/admin/reconciliation
```

Смотри блок `ledger`:

```json
{
  "balanced": true,
  "debit": 5000,
  "credit": 5000,
  "accounts": {
    "cash": 0,
    "deferred_revenue": 0,
    "revenue": 5000
  }
}
```

`balanced: true` — дебет равен кредиту по всей системе.

Там же `supplier_discrepancies` — дубли кодов и невыданные issue.

### 3. за период (бонус)

```
curl -s "localhost:3000/api/admin/ledger/period?from=2025-01-01T00:00:00.000Z&to=2025-12-31T23:59:59.999Z"
```

`debit = credit`, `balanced: true`.

### 4. автотесты

```
npm test
```

Тесты `ledger balances` и `multi-item partial fulfillment with refund` проверяют сходимость сами.

---

## вернуть поставщиков в норму

```
curl -s -X POST localhost:3000/internal/suppliers/A/behavior \
  -H 'content-type: application/json' \
  -d '{"mode":"normal"}'

curl -s -X POST localhost:3000/internal/suppliers/B/behavior \
  -H 'content-type: application/json' \
  -d '{"mode":"normal"}'
```

---

## тесты

```
npm test
```

