// Hand-written twin of update-restart.mjs, so the tests typecheck against
// the same shapes the main process uses.
export const RESTART_LIMITS: {
  look: number;
  drain: number;
  mark: number;
  staged: number;
  quit: number;
  orderly: number;
  forced: number;
  teardown: number;
};

export type Went<T> = { outcome: "done"; value: T } | { outcome: "failed"; error: unknown } | { outcome: "late" };

export function within<T>(work: () => T | Promise<T>, ms: number): Promise<Went<T>>;

export interface RestartSteps {
  look(): unknown;
  drain(): unknown;
  mark(): unknown;
  staged(): unknown;
  quit(): unknown;
  closeWindows(): number | Promise<number>;
  teardown(): unknown;
  exit(): void;
}

export function restartIntoUpdate(
  steps: RestartSteps,
  options?: {
    limits?: Partial<typeof RESTART_LIMITS>;
    log?: (line: string) => void;
    wait?: (ms: number) => Promise<void>;
    from?: string;
    to?: string;
  },
): Promise<"cancelled" | "exited">;

/** An update that did not install: the version this still is, and the
 * one it was meant to become when that was known. */
export interface NotInstalled {
  from: string;
  to: string | null;
}

export function markInstall(file: string, versions: { from: string; to?: string | null }): void;
export function takeInstallMark(file: string, current: string): NotInstalled | null;
