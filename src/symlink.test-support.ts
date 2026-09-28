import { symlink } from "node:fs/promises";
import type test from "node:test";

/**
 * Create a file symlink for a test. Windows only allows this with Developer Mode
 * or elevation; when it is refused, record a diagnostic and return false so the
 * caller can skip just the symlink assertion instead of failing the whole test.
 */
export async function trySymlink(context: test.TestContext, target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      context.diagnostic("Skipped symlink assertion: enable Windows Developer Mode to allow unprivileged symlinks");
      return false;
    }
    throw error;
  }
}
