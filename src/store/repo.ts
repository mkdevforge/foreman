import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CliError } from "../cli/errors";

export interface ForemanPaths {
  repoRoot: string;
  foremanDir: string;
  tasksDir: string;
  readmePath: string;
}

export function findRepoRoot(cwd = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8"
  });

  if (result.error) {
    throw new CliError(1, "git_not_found", `failed to run git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new CliError(2, "not_git_repository", "foreman requires a Git repository; run this inside a Git worktree");
  }

  return result.stdout.trim();
}

export function getGitUserEmail(cwd = process.cwd()): string | null {
  const result = spawnSync("git", ["config", "user.email"], {
    cwd,
    encoding: "utf8"
  });

  if (result.error) {
    throw new CliError(1, "git_not_found", `failed to run git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    return null;
  }

  const email = result.stdout.trim();
  return email.length > 0 ? email : null;
}

export function getGitOriginRemote(cwd = process.cwd()): string | null {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd,
    encoding: "utf8"
  });

  if (result.error) {
    throw new CliError(1, "git_not_found", `failed to run git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    return null;
  }

  const remote = result.stdout.trim();
  return remote.length > 0 ? remote : null;
}

export function normalizeGitRemoteUrl(remote: string): string {
  const trimmed = remote.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const urlRemote = normalizeUrlRemote(trimmed);
  if (urlRemote !== null) {
    return urlRemote;
  }

  const scpLikeRemote = normalizeScpLikeRemote(trimmed);
  if (scpLikeRemote !== null) {
    return scpLikeRemote;
  }

  return stripGitSuffix(trimmed).toLowerCase();
}

export function getForemanPaths(repoRoot: string): ForemanPaths {
  const foremanDir = join(repoRoot, ".foreman");

  return {
    repoRoot,
    foremanDir,
    tasksDir: join(foremanDir, "tasks"),
    readmePath: join(foremanDir, "README.md")
  };
}

function normalizeUrlRemote(remote: string): string | null {
  try {
    const url = new URL(remote);
    const host = url.hostname.toLowerCase();
    const path = stripGitSuffix(decodeURIComponent(url.pathname).replace(/^\/+/, ""));

    return path.length === 0 ? host : `${host}/${path}`.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeScpLikeRemote(remote: string): string | null {
  const match = /^(?:[^@/:]+@)?([^:]+):(.+)$/.exec(remote);
  if (match === null) {
    return null;
  }

  const host = match[1].toLowerCase();
  const path = stripGitSuffix(match[2].replace(/^\/+/, ""));
  return path.length === 0 ? host : `${host}/${path}`.toLowerCase();
}

function stripGitSuffix(value: string): string {
  return value.replace(/\/+$/, "").replace(/\.git$/i, "");
}
