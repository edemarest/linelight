# LineLight Web

Map-first Next.js frontend for LineLight. It renders the live MBTA map, stop sheets, trip planning, and follow mode by calling the backend API and fetching landmark images from S3.

## Quickstart (local dev)

From the repo root:

```bash
npm install

cp web/.env.example web/.env.local

npm run dev:web
```

Open `http://localhost:3000`.

## Environment

`web/.env.local` supports these common values:

- `NEXT_PUBLIC_API_BASE_URL` (defaults to `http://localhost:4000` when running on localhost)
- `NEXT_PUBLIC_LANDMARKS_BASE_URL` (S3 base URL for landmark images)
- `NEXT_PUBLIC_TRIP_PLANNER_TIMEOUT_MS` (optional)
- `NEXT_PUBLIC_DEFAULT_MAP_LAT`, `NEXT_PUBLIC_DEFAULT_MAP_LNG`, `NEXT_PUBLIC_DEFAULT_MAP_ZOOM` (optional)

## Key files

- `web/src/components/home/HomeShell.tsx` — primary map UI shell
- `web/src/components/stop/StopSheetPanel.tsx` — stop sheet UI
- `web/src/lib/api.ts` — frontend API wrapper
- `web/src/lib/config.ts` — env config with defaults
- `web/src/lib/designTokens.ts` — UI color tokens

## Scripts

```bash
npm --workspace web run dev
npm --workspace web run build
npm --workspace web run lint
```
