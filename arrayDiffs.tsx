export function arrayDiffs<T>(): TransformStream<T[], { added: T[]; changed: T[]; deleted: T[]; }> {
    const seen = new Set();
    return new TransformStream({
        transform(chunk, controller) {
            const added = chunk.filter(e => !seen.has(e));
            const changed = chunk.filter(e => seen.has(e));
            const deleted = Array.from(seen).filter(e => !chunk.includes(e));
            added.forEach(e => seen.add(e));
            changed.forEach(e => seen.delete(e));
            deleted.forEach(e => seen.delete(e));
            if (added.length === 0 && changed.length === 0 && deleted.length === 0) return;
            controller.enqueue({ added, changed, deleted });
        },
    });
}
