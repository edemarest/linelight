import fs from "node:fs";

type PgSslConfig = { ca?: string; rejectUnauthorized: boolean; servername?: string };

export const buildPgSslConfig = (databaseUrl?: string): PgSslConfig | undefined => {
  const sslRootCertPath = process.env.PGSSLROOTCERT?.trim();
  const sslServerName = process.env.PGSSL_SERVERNAME?.trim();
  const sslRejectUnauthorized = process.env.PGSSLREJECTUNAUTHORIZED?.trim() === "false" ? false : true;
  const pgSslMode = process.env.PGSSLMODE?.trim();
  const urlSslMode = (() => {
    if (!databaseUrl) return null;
    try {
      return new URL(databaseUrl).searchParams.get("sslmode");
    } catch {
      return null;
    }
  })();

  if (sslRootCertPath) {
    return {
      ca: fs.readFileSync(sslRootCertPath, "utf-8"),
      rejectUnauthorized: sslRejectUnauthorized,
      ...(sslServerName ? { servername: sslServerName } : {}),
    };
  }

  if (pgSslMode === "require" || urlSslMode === "require") {
    return { rejectUnauthorized: false };
  }

  return undefined;
};
