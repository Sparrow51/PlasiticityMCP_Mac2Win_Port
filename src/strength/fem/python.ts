// Python for the local Gmsh/OCC workers. On Windows `python3` is usually only the
// Microsoft Store stub, while python.org and conda installs provide `python`.
export function defaultPythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLASTICITY_FEA_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
}
