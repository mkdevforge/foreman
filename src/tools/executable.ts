import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function findExecutableCommand(
  binaryName: string,
  env: Record<string, string | undefined> = process.env
): string | null {
  const pathMatch = findExecutableOnPath(binaryName, env.PATH, env.HOME);
  if (pathMatch !== null) {
    return pathMatch;
  }

  for (const dir of fallbackUserBinDirs(env.HOME)) {
    const candidate = join(dir, binaryName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveExecutableCommand(
  binaryName: string,
  env: Record<string, string | undefined> = process.env
): string {
  return findExecutableCommand(binaryName, env) ?? binaryName;
}

function findExecutableOnPath(
  binaryName: string,
  pathValue: string | undefined,
  homeDir: string | undefined
): string | null {
  if (pathValue === undefined || pathValue.length === 0) {
    return null;
  }

  for (const rawEntry of pathValue.split(delimiter)) {
    if (rawEntry.length === 0) {
      continue;
    }

    const entry = expandHome(rawEntry, homeDir);
    const candidate = join(entry, binaryName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function fallbackUserBinDirs(homeDir: string | undefined): string[] {
  if (homeDir === undefined || homeDir.length === 0) {
    return [];
  }

  return [
    join(homeDir, ".local", "bin"),
    join(homeDir, ".bun", "bin"),
    join(homeDir, ".npm-global", "bin"),
    join(homeDir, "Library", "pnpm")
  ];
}

function expandHome(pathEntry: string, homeDir: string | undefined): string {
  if (pathEntry === "~") {
    return homeDir ?? pathEntry;
  }

  if (pathEntry.startsWith("~/") && homeDir !== undefined && homeDir.length > 0) {
    return join(homeDir, pathEntry.slice(2));
  }

  return pathEntry;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
