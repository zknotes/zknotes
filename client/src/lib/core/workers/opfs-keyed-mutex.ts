/** One chain per key — OPFS allows only one SyncAccessHandle / Writable per file. */
export class OpfsKeyedMutex {
    private tails = new Map<string, Promise<unknown>>();

    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.tails.get(key) ?? Promise.resolve();
        const result = prev.catch(() => {}).then(fn);
        this.tails.set(key, result);
        return result.finally(() => {
            if (this.tails.get(key) === result) this.tails.delete(key);
        });
    }
}
