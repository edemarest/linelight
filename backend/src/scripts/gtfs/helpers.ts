import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import type { PoolClient } from "pg";

export type CsvRecord = Record<string, string>;

export const parseCsv = <T extends CsvRecord>(buffer: Buffer) =>
  parse(buffer, { columns: true, skip_empty_lines: true, trim: true }) as T[];

const chunk = <T,>(items: T[], size: number) => {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
};

export const insertBatch = async (
  client: PoolClient,
  table: string,
  columns: string[],
  rows: Array<(string | number | null)[]>,
  conflictClause: string,
) => {
  if (rows.length === 0) return;
  const columnList = columns.map((col) => `"${col}"`).join(", ");
  for (const batch of chunk(rows, 1000)) {
    const values: Array<string | number | null> = [];
    const placeholders = batch
      .map((row, rowIndex) => {
        const offset = rowIndex * columns.length;
        values.push(...row);
        const fields = columns.map((_, idx) => `$${offset + idx + 1}`).join(", ");
        return `(${fields})`;
      })
      .join(", ");
    const sql = `INSERT INTO ${table} (${columnList}) VALUES ${placeholders} ${conflictClause}`;
    await client.query(sql, values);
  }
};

export const downloadGtfs = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download GTFS: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

export const readEntry = (zip: AdmZip, name: string) => {
  const entry = zip.getEntry(name);
  if (!entry) {
    throw new Error(`Missing GTFS entry: ${name}`);
  }
  return entry.getData();
};
