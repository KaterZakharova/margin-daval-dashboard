# margin-vip-clients

Внутренняя страница для руководства: динамика топ-20 VIP-клиентов 2024 → 2026.

**Прод:** https://vip-clients.vercel.app
**Источник данных:** `../data.json` (margin-daval-dashboard) → `src/data/clients.json`

## Обновить данные

```bash
# из корня margin-daval-dashboard:
node scripts/build_vip_dataset.js
cd vip-clients
vercel --prod --scope katerzakharovas-projects
```

`build_vip_dataset.js` нормализует имена (Лакса→Ювелит, дубли «(S3)» и trailing space), вычисляет YoY, прогноз 2026 = `YTD'26 × (полный 2025 / YTD'25)` с cap'ом 2.5x от взрыва.

## Добавить скрин переписки

1. Положить файл в `public/clients/<slug>/screenshot.png`. Slug'и см. в `src/data/clients.json` (поле `slug`).
2. В `src/data/clientsMeta.json` дополнить:
```json
{
  "clients": {
    "matrix": {
      "notes": "Контакт: Иванов. Просили снизить тираж на Q3.",
      "screenshots": [
        { "file": "matrix-may-2026.png", "caption": "Переписка май 2026 — снижение объёма" }
      ]
    }
  }
}
```
3. Передеплоить.

## Структура

- `scripts/build_vip_dataset.js` (в родительском репо) — сборка `clients.json`
- `src/App.tsx` — главный layout (KPI, hero, грид)
- `src/components/HeroChart.tsx` — большой график с toggle revenue/qty/margin
- `src/components/ClientCard.tsx` — мини-карточка в гриде (4×5)
- `src/components/ClientModal.tsx` — fullscreen-модал клиента
- `src/data/clients.json` — данные (генерируется)
- `src/data/clientsMeta.json` — notes + скриншоты (правится руками)
