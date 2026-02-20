import { watch, type FileChanges, type FileInfo } from '@snomiao/glob-watch'
import type { FileChangeInfo } from 'fs/promises';
import promiseAllProperties from 'promise-all-properties';
import { add, map } from 'rambda';
import sflow, { sf } from 'sflow';
import { promisify } from 'util';
/** return glob all list, and then watch changes to got changed [filename], note that changed [filename] may be deleted */
type Awaitable<T> = T | Promise<T>;
export const mapChanges = <T, R>(fn: (value: T) => Awaitable<R>) => async ({ added, changed, deleted }: { added: T, changed: T, deleted: T }) => {
  return promiseAllProperties({
    added: fn(added),
    changed: fn(changed),
    deleted: fn(deleted)
  })
}

export function globFlow(
  pattern: string,
  {
    signal = new AbortController().signal,
    cwd = process.cwd(),
    // ignores: string[] = [],
  } = {}
) {
  type ret = {
    added: FileInfo[];
    changed: FileInfo[];
    deleted: FileInfo[];
    all: FileInfo[];
  };
  let state = { latest: undefined as ret | undefined }
  const nextPromise = Promise.withResolvers<ret>()
  return Object.assign(sflow(new ReadableStream<ret>({
    start(controller) {
      const destoryPromise = watch(pattern, async (changes) => {
        const vals = {
          added: [...changes.added.values()],
          changed: [...changes.changed.values()],
          deleted: [...changes.deleted.values()],
        };
        const all = new Set((state.latest?.all ?? []))
        vals.added.forEach((file) => all.add(file));
        vals.deleted.forEach((file) => all.delete(file));
        const ret = {
          ...vals,
          all: [...all.values()],
        };
        nextPromise.resolve(ret);
        controller.enqueue(ret);
        controller.close();
      }, { cwd, })
      signal.addEventListener('abort', () => destoryPromise.then((destory) => destory()))
    }
  })), {
    latest: async () => {
      if (state.latest) return state.latest;
      return await nextPromise.promise;
    },
    all: async () => {
      if (state.latest) return state.latest.all;
      return (await nextPromise.promise).all;
    }
  })
}

