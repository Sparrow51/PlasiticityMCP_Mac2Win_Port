import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { resolveWorkbenchConfig } from "../src/server/config.ts";
import { readOwnerToken } from "../src/server/owner-auth.ts";

const config = resolveWorkbenchConfig({
  env: process.env,
  args: process.argv.slice(2),
  cwd: resolve(import.meta.dirname, "../.."),
  home: homedir(),
});
const token = await readOwnerToken(config.projectsRoot);
const origin = process.env.WORKBENCH_ORIGIN ?? `http://${config.host}:${config.port}`;
const url = new URL(origin);
if (url.protocol !== "http:" || url.hostname !== config.host || Number(url.port) !== config.port) {
  throw new Error("Workbench owner URL must match the configured local service");
}
url.hash = new URLSearchParams({ owner: token }).toString();
// rundll32 hands the URL to the default browser without cmd.exe parsing it.
const [opener, ...openerArgs] = process.platform === "darwin"
  ? ["open"]
  : process.platform === "win32"
    ? ["rundll32.exe", "url.dll,FileProtocolHandler"]
    : ["xdg-open"];
await promisify(execFile)(opener!, [...openerArgs, url.toString()]);
