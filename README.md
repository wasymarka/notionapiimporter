# Notion Template CLI

CLI do klonowania i tworzenia szablonów Notion na podstawie istniejących stron/baz oraz lokalnych plików JSON.

## Instalacja

- Node.js >= 18 (zalecane 20)
- Ustaw zmienną środowiskową NOTION_TOKEN w pliku `.env`:

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

## Uwagi

- Pamiętaj, aby udzielić integracji dostępu do odpowiednich przestrzeni/stron w Notion.
- API ma limity – w narzędziu użyto prostego ogranicznika współbieżności i retry z backoffem.
- Przy klonowaniu bazy docelowy `targetId` musi być Page ID.