export const logError: (
  topic: string
) => (reason: any) => void | PromiseLike<void> = (topic) => (e) =>
  console.error(topic, e.message ?? e);

