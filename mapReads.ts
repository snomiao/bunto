import type { AsyncOrSync } from "ts-essentials";

export function mapReads<T, R>(fn: (x: T, i: number) => AsyncOrSync<R>) {
  let i = 0;
  return new TransformStream<
    T,
    { value: R; done: false } | { value: undefined; done: true }
  >({
    transform: async (chunk, ctrl) => {
      const ret = fn(chunk, i++);
      const value = ret instanceof Promise ? await ret : ret;
      ctrl.enqueue({ value, done: false });
    },
    flush: async (ctrl) => {
      ctrl.enqueue({ value: undefined, done: true });
    },
  });
}
