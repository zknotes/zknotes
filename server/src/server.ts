// The composition root: which extensions this installation has (seam 1).
//
// This is the **open-core** version: the list is empty and stays empty here. The core does not know
// whether any extension exists, and that is the whole point — the dependency direction is
// extension → core, never the other way round. An extended deployment's entrypoint imports
// `buildApp` and passes in its own extensions.
import type { FastifyInstance } from "fastify";

export type ApiExtension = {
    readonly name: string;
    readonly register: (fastify: FastifyInstance) => Promise<void>;
};

/** What is brought up when the caller says nothing else. In open-core: nothing. */
export const defaultExtensions: readonly ApiExtension[] = [];
