# Notion Template CLI

CLI do klonowania i tworzenia szablonów Notion na podstawie istniejących stron/baz oraz lokalnych plików JSON.

## Instalacja

- Node.js >= 18 (zalecane 20)\n- Ustaw zmienną środowiskową NOTION_TOKEN w pliku `.env`:

```
NOTION_TOKEN=YOUR_NOTION_TOKEN_HERE
```

## Użycie

Wyświetl pomoc:

```
node index.js --help
```

Lub po zainstalowaniu globalnie (opcjonalnie):

```
npm i -g .
notion-template --help
```

### Komendy

- from-master <masterId> <targetId>
  - Klonuje istniejącą stronę lub bazę do wskazanego miejsca.
  - Opcje:
    - --mode under_page | into_database

- from-json <templatePath> <targetId> --parentType page|database
  - Tworzy obiekt z lokalnego pliku JSON.
  - Szablon `kind: page` można umieścić pod stroną (parentType=page) lub jako wpis w bazie (parentType=database, wymagane właściwości).
  - Szablon `kind: database` musi mieć `parentType=page`.

- to-json <id> [outFile] (alias: export-json)
  - Eksportuje istniejącą stronę lub bazę do przenośnego szablonu JSON.
  - Jeśli `outFile` pominięty, JSON jest wypisywany na stdout.
  - Flagi: `--pretty` (domyślnie true)

## Przykłady

- Klon strony do innej strony:
```
node index.js from-master <PAGE_ID> <TARGET_PAGE_ID> --mode under_page
```

- Klon strony do bazy (jako nowy wpis):
```
node index.js from-master <PAGE_ID> <TARGET_DB_ID> --mode into_database
```

- Utworzenie strony z szablonu:
```
node index.js from-json templates/example-page.json <TARGET_PAGE_ID> --parentType page
```

- Utworzenie bazy z szablonu:
```
node index.js from-json templates/example-database.json <TARGET_PAGE_ID> --parentType page
```

- Eksport strony do JSON:
```
node index.js to-json <PAGE_OR_DB_ID> templates/export.json
```

## Notion Apps – Szybki start (Time Tracker)

Poniższe kroki pokazują jak wdrożyć przykładową aplikację Time Tracker z blueprintu YAML, wraz z backendem akcji i komendami utrzymaniowymi.

1) Backend – wybierz jedną z opcji:
- Vercel:
  - Skopiuj katalog `backend-template/vercel` do własnego repo/projektu Vercel.
  - Ustaw zmienne środowiskowe: `APP_SECRET` (silny sekret HMAC) i `NOTION_TOKEN`.
  - Uruchom deploy. Endpointy akcji dostępne będą pod: `https://<twoja-apka>.vercel.app/api/a/{start|pause|stop}` oraz webhook `POST /api/webhook/:name?secret=APP_SECRET`.
- Cloudflare Workers:
  - Skopiuj katalog `backend-template/workers`.
  - W pliku `wrangler.toml` ustaw `name` i dodaj zmienne `APP_SECRET`, `NOTION_TOKEN` (np. `wrangler secret put APP_SECRET`).
  - Deploy: `wrangler deploy`. Endpointy: `https://<twoja-nazwa>.workers.dev/a/{start|pause|stop}` i webhook `POST /webhook/:name?secret=APP_SECRET`.

2) Konfiguracja blueprintu:
- Edytuj `blueprints/time-tracker-system.yml` i ustaw `backend.baseUrl` na adres backendu (bez końcowego `/`).
- Opcjonalnie dostosuj sekcję `workflows` (np. `attach_action_links`, `webhook`, `property_change`).

3) Wdrożenie do Notion:
```
node index.js deploy blueprints/time-tracker-system.yml <TARGET_PAGE_ID> \
  --baseUrl "https://<twoja-apka>/api" \
  --appSecret "<APP_SECRET>"
```
- Komenda utworzy bazy (Tasks, Calendar), stronę „Time Tracker”, zasieje przykładowe dane i podstawi podpisane linki Start/Pause/Stop w wierszach Tasks.
- Dodatkowo powstanie strona „Installed” z podsumowaniem i sekcją „Workflows”.

4) Utrzymanie linków akcji (bez pełnego redeploy):
```
node index.js refresh-actions <TASKS_DB_ID> \
  --baseUrl "https://<twoja-apka>/api" \
  --appSecret "<APP_SECRET>" \
  [--calendarDbId <CALENDAR_DB_ID>]
```
- Nadpisuje właściwości URL (Start URL/Pause URL/Stop URL) dla wszystkich zadań w wybranej bazie.

5) Testowanie w Notion:
- Otwórz bazę Tasks, kliknij Start aby uruchomić licznik (ustawia Status „In Progress”, zaznacza „Timer Running”, ustawia „Last Started At”).
- Kliknij Pause aby zaktualizować „Total Tracked (min)” o czas od ostatniego startu i zatrzymać licznik.
- Kliknij Stop aby zakończyć zadanie (Status „Done”), zapisać czas i dodać wpis w Calendar (z relacją do zadania).

Uwagi dot. bezpieczeństwa:
- Linki akcji są podpisane HMAC z użyciem `APP_SECRET` – backend weryfikuje `sig` i parametry.
- Integracja Notion powinna mieć minimalne uprawnienia (tylko do wymaganych baz/stron).

Sekcja Workflows w YAML:
- `attach_action_links`: automatyczne podpięcie linków akcji do bazy `tasks` (opcjonalnie wskazanie `calendar_database`).
- `webhook`: dokumentuje dostępny endpoint webhook (np. `POST /webhook/task-completed`).
- `property_change`: opisuje sugerowany trigger (np. zmiana Status -> wywołanie webhooka). Implementacja automatyzacji leży po stronie Notion automations/Zapier/Make.

## Uwagi

- Pamiętaj, aby udzielić integracji dostępu do odpowiednich przestrzeni/stron w Notion.
- API ma limity – w narzędziu użyto prostego ogranicznika współbieżności i retry z backoffem.
- Przy klonowaniu bazy docelowy `targetId` musi być Page ID.