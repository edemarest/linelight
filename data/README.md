# Data Files

This folder contains MBTA-derived datasets used for local development and offline analysis. These files are not required for the app to run in production unless explicitly referenced.

## Contents

- `mbta-stops.json` — MBTA stop metadata (full export).
- `mbta-rapid-stops.csv` — MBTA rapid transit stops (CSV subset).
- `stop-locations.json` — Stop locations exported for local use.
- `stop-locations.tsv` — Stop locations (TSV version).

## Source & provenance

These files were generated from the MBTA public data feeds (GTFS/GTFS‑RT). If you refresh them, note the source URL and date in the commit message or update this file with the new timestamp.
