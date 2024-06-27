export type PartialUnion<T> = (T extends any ? (x: T) => any : never) extends (
  x: infer R
) => any ? Partial<R> : never;
