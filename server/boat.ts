// Where an agent's cloud computer lives.
//
// The service was Box on ascii.dev and is now Boat on boat.dev. The old
// address answers 404, and the new API names the same things differently:
// a box is a sandbox (/sandboxes, and `sandbox` or `sandboxes` in a
// reply), a prompt run's status sits under `promptRun`, and a run that
// worked is `finished`. Everything else, states included, is as it was.
// Kept in one place so the next move is one line.
//
// In this codebase it is still "the box" and the config key is still
// `box`, so a key saved before the move keeps working.
export const BOAT_API = "https://boat.dev/api/v1";

/** Every sandbox on the account, following the list's cursor. The list is
 * paged now, and an agent's machine found only on page one would be
 * replaced by a second one on the same bill. */
export async function listSandboxes(token: string): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`${BOAT_API}/sandboxes?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body: any = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) break;
    all.push(...(body?.sandboxes ?? []));
    cursor = body?.pageInfo?.nextCursor ?? null;
    if (!cursor || !body?.pageInfo?.hasMore) break;
  }
  return all;
}
