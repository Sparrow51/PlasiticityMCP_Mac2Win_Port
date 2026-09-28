import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { CdpClient } from "../cdp/client.ts";
import { discoverPlasticityTargets, type PlasticityTarget } from "../cdp/discovery.ts";

const execFileAsync = promisify(execFile);

export interface InspectorClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): () => void;
}

export async function unlockMainProcess(client: InspectorClient, rendererPort: number): Promise<void> {
  let receivePause: ((params: unknown) => void) | undefined;
  const paused = new Promise<unknown>((resolve) => { receivePause = resolve; });
  const unsubscribe = client.on("Debugger.paused", (params) => receivePause?.(params));
  try {
    await client.send("Runtime.enable");
    await client.send("Debugger.enable");
    await client.send("Runtime.runIfWaitingForDebugger");
    const pause = await withTimeout(paused, 10_000, "Plasticity main process did not pause at startup") as {
      callFrames?: Array<{ callFrameId?: string }>;
    };
    const callFrameId = pause.callFrames?.[0]?.callFrameId;
    if (!callFrameId) throw new Error("Plasticity startup call frame is unavailable");
    const expression = `(() => {
      const { app } = process.mainModule.require('electron');
      const commandLine = app.commandLine;
      const originalRemoveSwitch = commandLine.removeSwitch.bind(commandLine);
      commandLine.removeSwitch = name => {
        if (name === 'remote-debugging-port' || name === 'remote-debugging-pipe') return;
        return originalRemoveSwitch(name);
      };
      commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
      commandLine.appendSwitch('remote-debugging-port', '${rendererPort}');
      return { patched: true, port: commandLine.getSwitchValue('remote-debugging-port') };
    })()`;
    const evaluation = await client.send("Debugger.evaluateOnCallFrame", {
      callFrameId,
      expression,
      returnByValue: true,
    }) as { result?: { value?: { patched?: boolean; port?: string } }; exceptionDetails?: unknown };
    if (evaluation.exceptionDetails || evaluation.result?.value?.patched !== true) {
      throw new Error("Plasticity rejected the loopback CDP startup hook");
    }
    await client.send("Debugger.resume");
  } finally {
    unsubscribe();
  }
}

export async function ensurePlasticityCdp(options: {
  rendererPort?: number;
  inspectorPort?: number;
  applicationPath?: string;
  userDataDirectory?: string;
} = {}): Promise<PlasticityTarget[]> {
  if (options.userDataDirectory && !isAbsolute(options.userDataDirectory)) {
    throw new Error("An isolated Plasticity user-data directory must be an absolute path");
  }
  const rendererPort = options.rendererPort ?? 9223;
  const inspectorPort = options.inspectorPort ?? 9229;
  const endpoint = `http://127.0.0.1:${rendererPort}`;
  const current = await tryDiscover(endpoint);
  if (current.length > 0) {
    if (options.userDataDirectory) throw new Error("The isolated Plasticity CDP port is already in use; refusing to attach to another session");
    return current;
  }

  const running = options.userDataDirectory ? false : await isPlasticityRunning();
  if (running) {
    throw new Error("Plasticity is running without MCP access. The launcher will not close or restart it. Save your work, quit Plasticity, then run the launcher again to enable loopback debugging.");
  }

  const applicationPath = options.applicationPath ?? process.env.PLASTICITY_APP_PATH ?? defaultApplicationPath();
  const launchArguments = [`--inspect-brk=127.0.0.1:${inspectorPort}`];
  if (options.userDataDirectory) launchArguments.push(`--user-data-dir=${options.userDataDirectory}`);
  await launchPlasticity(applicationPath, launchArguments);
  const inspectorTarget = await waitForInspector(inspectorPort);
  const client = await CdpClient.connect(inspectorTarget.webSocketDebuggerUrl);
  try {
    await unlockMainProcess(client, rendererPort);
  } finally {
    client.close();
  }

  return await waitForTargets(endpoint);
}

export function defaultApplicationPath(): string {
  if (process.platform !== "win32") return "/Applications/Plasticity.app";
  // Per-user installs live in %LOCALAPPDATA%; the machine-wide MSI uses Program Files.
  const roots = [
    join(process.env.LOCALAPPDATA ?? "", "Plasticity"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Plasticity"),
  ];
  for (const root of roots) {
    // Squirrel installs keep each version in app-<version>; launch the exe directly so
    // our arguments are not swallowed by the top-level update stub.
    const versions = existsSync(root)
      ? readdirSync(root)
        .filter((name) => /^app-\d+(\.\d+)*$/u.test(name) && existsSync(join(root, name, "Plasticity.exe")))
        .sort((a, b) => compareVersions(b.slice(4), a.slice(4)))
      : [];
    const preferred = versions.includes("app-26.1.3") ? "app-26.1.3" : versions[0];
    if (preferred) return join(root, preferred, "Plasticity.exe");
  }
  throw new Error(`Could not find Plasticity under ${roots.join(" or ")}. Set PLASTICITY_APP_PATH to the full path of Plasticity.exe.`);
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function launchPlasticity(applicationPath: string, launchArguments: string[]): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-na", applicationPath, "--args", ...launchArguments]);
    return;
  }
  if (!existsSync(applicationPath)) throw new Error(`Plasticity executable not found: ${applicationPath}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(applicationPath, launchArguments, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function isPlasticityRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq Plasticity.exe", "/NH", "/FO", "CSV"], { encoding: "utf8" });
      return /"Plasticity\.exe"/iu.test(stdout);
    }
    await execFileAsync("pgrep", ["-x", "Plasticity"]);
    return true;
  } catch {
    return false;
  }
}

async function waitForInspector(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: "manual" });
      const payload = await response.json() as Array<{ webSocketDebuggerUrl?: string }>;
      const target = payload.find((item) => typeof item.webSocketDebuggerUrl === "string");
      if (target?.webSocketDebuggerUrl) return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for the Plasticity main-process inspector");
}

async function waitForTargets(endpoint: string): Promise<PlasticityTarget[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const targets = await tryDiscover(endpoint);
    if (targets.length > 0) return targets;
    await delay(100);
  }
  throw new Error("Timed out waiting for the Plasticity renderer CDP endpoint");
}

async function tryDiscover(endpoint: string): Promise<PlasticityTarget[]> {
  try {
    return await discoverPlasticityTargets(endpoint);
  } catch {
    return [];
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
