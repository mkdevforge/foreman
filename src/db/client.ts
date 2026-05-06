import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyConnectionPragmas, migrateDatabaseSchema } from "./schema";

export interface OpenForemanDatabaseOptions {
  databasePath?: string;
  homeDir?: string;
}

export function getDefaultForemanDatabasePath(homeDir = homedir()): string {
  return join(homeDir, ".foreman", "foreman.db");
}

export function openForemanDatabase(options: OpenForemanDatabaseOptions = {}): Database {
  const databasePath = options.databasePath ?? getDefaultForemanDatabasePath(options.homeDir);

  if (options.databasePath === undefined) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath, {
    create: true,
    readwrite: true,
    strict: true
  });

  try {
    applyConnectionPragmas(db);
    migrateDatabaseSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
