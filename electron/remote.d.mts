// Hand-written twin of the parts of remote.mjs the tests use, so they
// typecheck against the same shapes the main process uses.

export interface RemoteProfile {
  relayUrl: string;
  relayToken: string;
  deviceId: string;
  deviceToken: string;
  host?: string;
}

export function startRemoteProxy(
  profile: RemoteProfile,
  options?: { staticDir?: string; port?: number; onState?: (state: Record<string, unknown>) => void },
): Promise<{ port: number; stop: () => void }>;
