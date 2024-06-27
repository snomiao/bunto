// const ignores = Promise.withResolvers();
// ignores.resolve(1);
// peekYaml(await ignores.promise, "1");
// ignores.resolve(2);
// ignores.reject(2);
// peekYaml(await ignores.promise, "2");

export default function promiseWithResolvers<T>() {
  let { promise, reject, resolve } = Promise.withResolvers<T>();
  return Object.assign(promise, { reject, resolve });
}
// export default function reuseablePromise<T>() {
//   let { promise, reject, resolve } = Promise.withResolvers<T>();
//   return Object.assign(promise, { reject, resolve });
// }
