
export const logError: (reason: any) => void | PromiseLike<void> = (e) => console.error(e.message ?? e);
