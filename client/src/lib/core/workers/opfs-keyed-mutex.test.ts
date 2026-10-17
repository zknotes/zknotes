import { describe, expect, it } from "vitest";
import { OpfsKeyedMutex } from "./opfs-keyed-mutex";

describe("OpfsKeyedMutex", () => {
    it("serializes operations on the same key", async () => {
        const mutex = new OpfsKeyedMutex();
        const order: number[] = [];

        const first = mutex.run("a", async () => {
            order.push(1);
            await new Promise((r) => setTimeout(r, 30));
            order.push(2);
        });
        const second = mutex.run("a", async () => {
            order.push(3);
        });

        await Promise.all([first, second]);
        expect(order).toEqual([1, 2, 3]);
    });

    it("allows parallel operations on different keys", async () => {
        const mutex = new OpfsKeyedMutex();
        let aDone = false;
        let bStarted = false;

        const a = mutex.run("a", async () => {
            await new Promise((r) => setTimeout(r, 20));
            aDone = true;
        });
        const b = mutex.run("b", async () => {
            bStarted = true;
        });

        await b;
        expect(bStarted).toBe(true);
        expect(aDone).toBe(false);
        await a;
        expect(aDone).toBe(true);
    });
});
