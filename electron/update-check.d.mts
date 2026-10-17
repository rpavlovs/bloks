// Hand-written twin of update-check.mjs, so the tests typecheck against the
// same shapes the main process uses.
export interface UpdateState {
  state: string;
  version?: string;
  percent?: number;
  reason?: string;
  draining?: unknown;
}

export type UpdateEvent = "checking" | "available" | "not-available" | "progress" | "downloaded" | "error";

export function updateFrame(
  current: UpdateState,
  event: UpdateEvent,
  detail?: { version?: string; percent?: number; reason?: string },
): UpdateState | null;

export function mayLookAgain(current: UpdateState): boolean;

/** What the look needs of the updater: electron-updater's has it. */
export interface LookingUpdater {
  autoDownload?: boolean;
  checkForUpdates(): Promise<{
    isUpdateAvailable?: boolean;
    updateInfo?: { version?: string };
    cancellationToken?: { cancel(): void };
  } | null>;
  downloadUpdate(cancellationToken?: { cancel(): void }): Promise<unknown>;
  on?(event: "download-progress", listener: () => void): unknown;
  removeListener?(event: "download-progress", listener: () => void): unknown;
}

export function newestBeforeInstall(
  updater: LookingUpdater,
  options?: { within?: number; quiet?: number; waiting?: string },
): Promise<string>;
