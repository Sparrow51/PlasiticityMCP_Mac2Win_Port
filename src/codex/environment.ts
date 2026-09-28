import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, delimiter, dirname, extname, join } from "node:path";

// Windows processes need these to find the user profile, temp space and system
// DLLs (networking and crypto fail without SystemRoot). They are absent on POSIX.
export const WINDOWS_ENVIRONMENT = [
  "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP",
  "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles",
  "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
] as const;

/**
 * Resolve the Codex CLI for spawning without a shell. On Windows, npm installs a
 * `codex.cmd` shim that Node cannot spawn directly, so find the native codex.exe
 * on PATH or inside the globally installed @openai/codex package instead.
 */
export function resolveCodexExecutable(executable: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32" || executable !== basename(executable) || extname(executable) !== "") return executable;
  const directories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const native = join(directory, `${executable}.exe`);
    if (existsSync(native)) return native;
  }
  for (const directory of directories) {
    if (!existsSync(join(directory, `${executable}.cmd`))) continue;
    for (const packageRoot of [join(directory, "node_modules", "@openai"), join(dirname(directory), "node_modules", "@openai")]) {
      const found = findFile(packageRoot, `${executable}.exe`, 8);
      if (found) return found;
    }
  }
  return executable;
}

function findFile(root: string, name: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(root)) return undefined;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return undefined; }
  for (const entry of entries) {
    const path = join(root, entry);
    if (entry.toLowerCase() === name && statSync(path).isFile()) return path;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    let directory = false;
    try { directory = statSync(path).isDirectory(); } catch { continue; }
    if (!directory) continue;
    const found = findFile(path, name, depth - 1);
    if (found) return found;
  }
  return undefined;
}
