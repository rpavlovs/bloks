// What an agent's backup may be.
//
// Another engine, or another model on the agent's own engine. Not the
// exact engine and model it already runs on: a turn that just failed
// there is not helped by being asked there again, which the retry before
// the backup has already done.
//
// A backup on the agent's own engine cannot stand in when that engine is
// out (a usage limit, no credit, signed out): every model on it is out
// with it. The server holds to that (backupFor in server/index.ts), and
// the settings say so beside the choice, so nobody counts on it there.

type Selection = { instanceId: string; model: string };
type Catalog<T extends { id: string } = { id: string }> = {
  instanceId: string;
  models: { default?: string | null; options: T[]; acceptsAnyId?: boolean };
};

/** The model a selection runs on: an empty one is the engine's default. */
function runs(instance: Catalog, model: string): string {
  return model || (instance.models.default ?? "");
}

/** Whether `model` on `instance` is exactly what `own` already runs. */
export function isOwnRun(instance: Catalog, model: string, own: Selection | null | undefined): boolean {
  return Boolean(own && instance.instanceId === own.instanceId && runs(instance, model) === runs(instance, own.model));
}

/** The models `instance` can offer as a backup for `own`. */
export function backupOptions<T extends { id: string }>(
  instance: Catalog<T>,
  own: Selection | null | undefined,
): T[] {
  return instance.models.options.filter((o) => !isOwnRun(instance, o.id, own));
}

/** Whether an engine has anything to offer as a backup for `own`: a
 * model besides the one it runs, or any id typed in. */
export function offersBackup(instance: Catalog, own: Selection | null | undefined): boolean {
  return Boolean(instance.models.acceptsAnyId) || backupOptions(instance, own).length > 0;
}

/** A backup on the agent's own engine, which covers failures but not
 * that engine being out. */
export function sameEngineBackup(own: Selection, backup: Selection | null | undefined): boolean {
  return Boolean(backup && backup.instanceId === own.instanceId);
}
