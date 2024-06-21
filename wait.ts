export async function wait<R>(fn: () => R): Promise<R> {
  return await fn();
}
