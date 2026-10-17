import { describe, expect, test } from "bun:test";
import { productionS3ConfigProblems } from "../../src/s3";

const REAL = {
    S3_ENDPOINT: "https://s3.example.net",
    S3_ACCESS_KEY: "AKIAEXAMPLEKEY",
    S3_SECRET_KEY: "a-real-secret-from-the-provider",
};

describe("productionS3ConfigProblems", () => {
    test("a real configuration has no problems", () => {
        expect(productionS3ConfigProblems(REAL)).toEqual([]);
    });

    test("no endpoint means the provider's own (AWS) — allowed", () => {
        expect(productionS3ConfigProblems({ ...REAL, S3_ENDPOINT: undefined })).toEqual([]);
    });

    test("the development credentials from the example file are refused", () => {
        const problems = productionS3ConfigProblems({
            ...REAL,
            S3_ACCESS_KEY: "minioadmin",
            S3_SECRET_KEY: "minioadmin-dev-secret",
        });
        expect(problems).toHaveLength(2);
    });

    test("missing credentials are refused", () => {
        expect(productionS3ConfigProblems({ ...REAL, S3_ACCESS_KEY: "" })).toHaveLength(1);
        expect(productionS3ConfigProblems({ ...REAL, S3_SECRET_KEY: undefined })).toHaveLength(1);
    });

    test("a loopback endpoint is refused — no browser can upload to the server's own localhost", () => {
        for (const endpoint of [
            "http://localhost:9000",
            "http://127.0.0.1:9000",
            "http://[::1]:9000",
            "http://0.0.0.0:9000",
        ]) {
            expect(productionS3ConfigProblems({ ...REAL, S3_ENDPOINT: endpoint })).toHaveLength(1);
        }
    });

    test("a plain http:// endpoint is refused — an https:// page cannot upload to it", () => {
        for (const endpoint of ["http://garage:3900", "http://s3.example.net"]) {
            expect(productionS3ConfigProblems({ ...REAL, S3_ENDPOINT: endpoint })).toEqual([
                "S3_ENDPOINT is not an https:// address.",
            ]);
        }
    });
});
