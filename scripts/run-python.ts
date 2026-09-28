// Run the platform's Python (see defaultPythonExecutable) with the given arguments.
import { spawnSync } from "node:child_process";

import { defaultPythonExecutable } from "../src/strength/fem/python.ts";

const result = spawnSync(defaultPythonExecutable(), process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
