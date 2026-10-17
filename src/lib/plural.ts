// "1 turn", "2 turns". Counts in the interface are read, not parsed, and
// "1 turns" reads like a mistake because it is one.
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
