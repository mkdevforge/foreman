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

export function getForemanPaths(repoRoot: string): ForemanPaths {
  const foremanDir = join(repoRoot, ".foreman");

  return {
    repoRoot,
    foremanDir,
    tasksDir: join(foremanDir, "tasks"),
    readmePath: join(foremanDir, "README.md")
  };
}
