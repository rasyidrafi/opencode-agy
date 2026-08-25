import { access, constants as fsConstants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AgyAbortError, AgyProcessError, AgyTimeoutError } from "./errors.js";
import { AGY_VERSION_MINIMUM, DEFAULT_MAX_STDERR_BYTES } from "./constants.js";
import { debug } from "./log.js";

export type AgyCaptureResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type AgyDetection = {
  executable: string;
  version: string | null;
  versionOutput: string;
};

let detectionPromise: Promise<AgyDetection> | null = null;

function candidateNames(): string[] {
  return process.platform === "win32" ? ["agy.exe", "agy", "agy.cmd"] : ["agy"];
}

async function executableFile(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeExecutablePath(path: string): Promise<string | undefined> {
  if (!(await executableFile(path))) return undefined;
  if (process.platform === "win32" && isWindowsCommandShim(path)) {
    const exe = `${path.slice(0, -extname(path).length)}.exe`;
    return (await executableFile(exe)) ? exe : undefined;
  }
  return path;
}

/** Resolve only the executable; no credential files or auth state are read. */
export async function resolveAgyExecutable(preferred?: string): Promise<string> {
  const configured = preferred?.trim() || process.env.OPENCODE_AGY_PATH?.trim();
  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(configured);
    const safe = await safeExecutablePath(path);
    if (safe) return safe;
    throw new AgyProcessError(`Configured agy executable was not found: ${path}`);
  }

  const names = candidateNames();
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const locations = [
    ...pathEntries.flatMap((entry) => names.map((name) => join(entry, name))),
    ...names.flatMap((name) => [
      join(homedir(), ".local", "bin", name),
      join(homedir(), ".bun", "bin", name),
    ]),
    ...(process.platform !== "win32"
      ? names.flatMap((name) => [join("/usr/local/bin", name), join("/usr/bin", name)])
      : [
          join(process.env.LOCALAPPDATA ?? "", "agy", "bin", "agy.exe"),
          join(process.env.USERPROFILE ?? "", "AppData", "Local", "agy", "bin", "agy.exe"),
        ]),
  ];
  const seen = new Set<string>();
  for (const location of locations) {
    if (!location || seen.has(location)) continue;
    seen.add(location);
    const safe = await safeExecutablePath(location);
    if (safe) return safe;
  }
  throw new AgyProcessError(
    "The official agy executable was not found on PATH or in its documented install locations. Install it from https://antigravity.google/docs/cli/install/.",
    undefined,
  );
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else if (signal === "SIGKILL") {
      // `ChildProcess.kill()` does not recursively terminate descendants on
      // Windows. taskkill is the documented OS mechanism for the process tree.
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref?.();
    } else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

export function terminateAgyProcess(child: ChildProcess, force = false): void {
  killProcessTree(child, force ? "SIGKILL" : "SIGTERM");
}

export async function captureAgyCommand(
  args: string[],
  options: {
    cwd?: string;
    executable?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<AgyCaptureResult> {
  const executable = await resolveAgyExecutable(options.executable);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_STDERR_BYTES * 4;
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: isWindowsCommandShim(executable),
    });
  } catch (error) {
    throw new AgyProcessError("Failed to start the official agy executable", error);
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let aborted = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;

  const append = (target: Buffer[], chunk: Buffer, current: number): number => {
    if (current >= maxOutputBytes) return current;
    const remaining = maxOutputBytes - current;
    const part = chunk.subarray(0, remaining);
    target.push(part);
    return current + part.byteLength;
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes = append(stdout, Buffer.from(chunk), stdoutBytes);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes = append(stderr, Buffer.from(chunk), stderrBytes);
  });

  let abortHandler: (() => void) | undefined;
  const result = new Promise<AgyCaptureResult>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      timedOut = true;
      terminateAgyProcess(child);
      forceTimer = setTimeout(() => terminateAgyProcess(child, true), 2_000);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
      if (error) rejectResult(error);
      else {
        resolveResult({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: child.exitCode,
          signal: child.signalCode,
        });
      }
    };
    child.once("error", (error) => finish(new AgyProcessError("The agy process failed to start or stopped unexpectedly", error)));
    child.once("close", () => {
      if (timedOut) finish(new AgyTimeoutError("The agy command timed out"));
      else if (aborted) finish(new AgyAbortError("The agy command was cancelled"));
      else finish();
    });
    abortHandler = () => {
      aborted = true;
      terminateAgyProcess(child);
      forceTimer = setTimeout(() => terminateAgyProcess(child, true), 2_000);
      forceTimer.unref?.();
    };
    if (options.signal?.aborted) abortHandler();
    else options.signal?.addEventListener("abort", abortHandler, { once: true });
  });
  const captured = await result;
  debug("completed agy diagnostic command", { exitCode: captured.exitCode, outputBytes: captured.stdout.length });
  return captured;
}

export async function detectAgy(force = false): Promise<AgyDetection> {
  if (!force && detectionPromise) return detectionPromise;
  detectionPromise = (async () => {
    const executable = await resolveAgyExecutable();
    const result = await captureAgyCommand(["--version"], {
      executable,
      timeoutMs: 15_000,
      maxOutputBytes: 16 * 1024,
    });
    const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
    const version = versionOutput.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
    if (result.exitCode !== 0 && !version) {
      throw new AgyProcessError("The official agy executable did not return a usable version");
    }
    if (version && compareVersions(version, AGY_VERSION_MINIMUM) < 0) {
      throw new AgyProcessError(`agy ${version} is older than the minimum supported version ${AGY_VERSION_MINIMUM}`);
    }
    return { executable, version, versionOutput };
  })();
  try {
    return await detectionPromise;
  } catch (error) {
    detectionPromise = null;
    throw error;
  }
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => (value.match(/^\d+(?:\.\d+){0,2}/)?.[0] ?? "0").split(".").map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function resetAgyDetectionCache(): void {
  detectionPromise = null;
}

export function executableDirectory(executable: string): string {
  return dirname(executable);
}

export function isWindowsCommandShim(executable: string): boolean {
  return process.platform === "win32" && [".cmd", ".bat", ".ps1"].includes(extname(executable).toLowerCase());
}
