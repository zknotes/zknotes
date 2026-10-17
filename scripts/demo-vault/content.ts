/**
 * The demo vault's content — one place to edit when you want different notes.
 *
 * It deliberately covers the editor's whole surface: headings, every inline mark, task lists,
 * tables, code blocks, block quotes, horizontal rules, KaTeX math, note-to-note links and inline
 * attachments, across two registers (wet-lab research and platform engineering).
 */

import {
    COST_TREND_SIZE,
    costTrendPng,
    coverageHeatmapPng,
    HEATMAP_SIZE,
    simplePdf,
} from "./assets";
import {
    attachment,
    b,
    code,
    colored,
    h,
    hr,
    i,
    image,
    link,
    mark,
    math,
    mono,
    noteLink,
    ol,
    p,
    quote,
    strike,
    sub,
    sup,
    table,
    tasks,
    u,
    ul,
} from "./html";
import { at, type DemoVault, VaultBuilder } from "./model";

const encoder = new TextEncoder();

export function buildDemoVault(seed: string): DemoVault {
    const v = new VaultBuilder(seed);

    // Resolved up front, so a note can link to one written further down.
    const ID = {
        thermostability: v.id("note/thermostability"),
        pgUpgrade: v.id("note/pg18-upgrade"),
        incident: v.id("note/incident-2026-08-14"),
        adr: v.id("note/decision-log"),
        costs: v.id("note/q3-costs"),
        heatmap: v.id("file/coverage-heatmap"),
        costChart: v.id("file/cost-trend"),
        pgPlan: v.id("file/pg18-plan"),
        costsCsv: v.id("file/costs-csv"),
        slaMetrics: v.id("file/sla-metrics"),
    } as const;

    // ── Folders ───────────────────────────────────────────────────────────────
    const research = v.folder(
        "folder/research",
        null,
        "Research",
        { created: at(2026, 5, 4) },
        {
            color: "#14b8a6",
            icon: "🔬",
        },
    );
    const assays = v.folder(
        "folder/assays",
        research,
        "Assays",
        { created: at(2026, 5, 11) },
        {
            icon: "🧪",
        },
    );
    const engineering = v.folder(
        "folder/engineering",
        null,
        "Engineering",
        { created: at(2026, 4, 20) },
        { color: "#3b82f6", icon: "💻" },
    );
    const runbooks = v.folder(
        "folder/runbooks",
        engineering,
        "Runbooks",
        { created: at(2026, 6, 2) },
        { icon: "🔧" },
    );
    const operations = v.folder(
        "folder/operations",
        null,
        "Operations",
        { created: at(2026, 7, 1) },
        { color: "#6366f1", icon: "📊" },
    );

    // ── Research ──────────────────────────────────────────────────────────────
    v.note(
        "note/nanopore-qc",
        research,
        "Nanopore run QC — standard protocol",
        [
            h(1, "Nanopore run QC — standard protocol"),
            p(
                `Applies to every ${b("R10.4.1")} flow cell run on the MinION. Run this before any ` +
                    `downstream basecalling; a run that fails step 3 is not worth the compute.`,
            ),
            h(2, "1. Pre-run checks"),
            ol([
                `Confirm the flow cell reports ${mono(">= 800")} available pores in MinKNOW.`,
                `Record the library concentration (Qubit dsDNA HS, not NanoDrop).`,
                `Check the fragment length distribution on the TapeStation — median above ${mono("8 kb")}.`,
            ]),
            quote(
                `${b("Why not NanoDrop:")} it measures total nucleic acid, so carry-over RNA inflates ` +
                    `the reading by 20–40% and the library is loaded well under target.`,
            ),
            h(2, "2. Loading"),
            code(
                "bash",
                `# Flush and prime, then load 75 µl of the library mix
minknow-cli protocol start \\
  --flow-cell-id FAX00123 \\
  --kit SQK-LSK114 \\
  --experiment-group thermostability \\
  --basecalling off`,
            ),
            h(2, "3. Acceptance thresholds"),
            table(
                ["Metric", "Pass", "Marginal", "Fail"],
                [
                    ["Pores at t=0", "≥ 800", "600–799", "< 600"],
                    ["Median read Q", "≥ 14", "12–13.9", "< 12"],
                    ["N50", "≥ 12 kb", "8–12 kb", "< 8 kb"],
                    ["Output at 24 h", "≥ 10 Gb", "6–10 Gb", "< 6 Gb"],
                ],
            ),
            p(
                `The quality score is the usual Phred transform, ${math("Q = -10\\log_{10} P_{err}")}, ` +
                    `so ${mono("Q14")} is roughly one error in 25 bases — fine for assembly polishing, ` +
                    `not for variant calling on a single read.`,
            ),
            h(2, "4. After the run"),
            tasks([
                [true, "Export the MinKNOW report as PDF and attach it to the run note"],
                [true, "Archive the raw POD5 to cold storage"],
                [false, "Re-basecall with the SUP model once the GPU queue clears"],
                [
                    false,
                    `Update ${noteLink(ID.thermostability, "Thermostability of β-glucosidase")} with the yields`,
                ],
            ]),
            p(
                `Reference: ${link("Oxford Nanopore protocol library", "https://community.nanoporetech.com/protocols")} ` +
                    `(login required).`,
            ),
        ].join(""),
        { created: at(2026, 5, 12), updated: at(2026, 9, 2, 14, 20) },
        { icon: "📡" },
    );

    const thermostabilityBody = [
        h(1, "Thermostability of β-glucosidase — assay log"),
        p(
            `Wild type versus the ${mono("N220Y/L305F")} double mutant. Residual activity after a ` +
                `15-minute heat challenge, measured against pNPG at pH 5.0.`,
        ),
        h(2, "Measurements"),
        table(
            ["Temperature (°C)", "WT residual (%)", "N220Y/L305F (%)", "n"],
            [
                ["50", "98.2 ± 1.1", "99.1 ± 0.8", "6"],
                ["60", "81.4 ± 2.7", "95.6 ± 1.4", "6"],
                ["65", "44.9 ± 3.9", "88.2 ± 2.1", "6"],
                ["70", "9.7 ± 2.2", "61.3 ± 4.0", "6"],
                ["75", "1.1 ± 0.6", "24.8 ± 3.7", "6"],
            ],
        ),
        p(
            `The half-inactivation temperature moves from T${sub("50")} ≈ 64.6 °C to ` +
                `${mark(`T${sub("50")} ≈ 71.8 °C`)} — a ${b("7.2 °C")} shift, which is well past ` +
                `what a single stabilising contact usually buys.`,
        ),
        h(2, "Inactivation kinetics"),
        p(
            `First-order loss of activity fits the Arrhenius form ` +
                `${math("k_{obs} = A\\,e^{-E_a/RT}")}, giving an activation energy of ` +
                `${mono("E_a = 214 kJ mol⁻¹")} for the wild type and ${mono("258 kJ mol⁻¹")} for the mutant.`,
        ),
        p(
            math(
                "\\ln\\frac{A_t}{A_0} = -k_{obs}\\,t \\quad\\Longrightarrow\\quad t_{1/2} = \\frac{\\ln 2}{k_{obs}}",
                true,
            ),
        ),
        h(2, "Flow cell coverage"),
        p(`Per-tile read depth for the confirmatory sequencing run, ${i("FAX00123")}:`),
        image(ID.heatmap, "coverage-heatmap.png", HEATMAP_SIZE),
        p(
            `Edge tiles drop off as expected. Nothing here suggests a loading problem, so the ` +
                `${strike("suspected bubble")} theory is dead.`,
        ),
        h(2, "Open questions"),
        ul([
            `Does the ${colored("N220Y", "#2563eb")} substitution alone account for the shift, or is ` +
                `${colored("L305F", "#dc2626")} doing the work?`,
            "Repeat at pH 4.0 — the industrial process runs acidic.",
            `Check whether CO${sub("2")} sparging changes the plateau (it did for the α-amylase work).`,
        ]),
        quote(
            `${b("Note to self:")} the 70 °C wild-type point has a suspiciously wide spread. Two of ` +
                `the six replicates came from the older enzyme lot — rerun them before this goes in a figure.`,
        ),
    ].join("");

    v.note(
        "note/thermostability",
        assays,
        "Thermostability of β-glucosidase — assay log",
        thermostabilityBody,
        { created: at(2026, 6, 3), updated: at(2026, 9, 9, 16, 45) },
        { icon: "🧪", starred: true },
    );

    v.file(
        "file/coverage-heatmap",
        ID.thermostability,
        "coverage-heatmap.png",
        "image/png",
        coverageHeatmapPng(),
        { created: at(2026, 9, 9, 16, 30) },
        "Per-tile read depth, flow cell FAX00123",
    );

    v.note(
        "note/kinetics",
        assays,
        "Substrate kinetics — Michaelis–Menten fits",
        [
            h(1, "Substrate kinetics — Michaelis–Menten fits"),
            p(`Initial rates against pNPG, 0.05–5 mM, 37 °C, triplicate.`),
            p(math("v_0 = \\frac{V_{max}\\,[S]}{K_M + [S]}", true)),
            table(
                ["Variant", "K_M (mM)", "V_max (µmol min⁻¹ mg⁻¹)", "k_cat/K_M (mM⁻¹ s⁻¹)"],
                [
                    ["Wild type", "0.42 ± 0.04", "18.9 ± 0.5", "31.2"],
                    ["N220Y", "0.51 ± 0.06", "18.1 ± 0.7", "24.6"],
                    ["L305F", "0.44 ± 0.03", "17.4 ± 0.4", "27.4"],
                    ["N220Y/L305F", "0.58 ± 0.07", "17.8 ± 0.6", "21.3"],
                ],
            ),
            p(
                `So the double mutant trades roughly ${b("a third of its catalytic efficiency")} for ` +
                    `the 7 °C stability gain. For the process that is a good trade — residence time is ` +
                    `not the bottleneck, enzyme replacement is.`,
            ),
            h(2, "Fit"),
            code(
                "python",
                `import numpy as np
from scipy.optimize import curve_fit

def mm(s, vmax, km):
    return vmax * s / (km + s)

s = np.array([0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0])
v = np.array([2.1, 3.8, 7.4, 10.3, 13.6, 16.1, 17.9])

(vmax, km), cov = curve_fit(mm, s, v, p0=[20, 0.5])
print(f"Vmax={vmax:.2f}  KM={km:.3f}  se={np.sqrt(np.diag(cov))}")`,
            ),
            quote(
                `Weighted fit, not the Lineweaver–Burk linearisation — the double-reciprocal plot ` +
                    `puts all the leverage on the noisiest, lowest-concentration points.`,
            ),
        ].join(""),
        { created: at(2026, 6, 18), updated: at(2026, 8, 27, 11, 10) },
    );

    v.note(
        "note/crispr-offtarget",
        research,
        "CRISPR off-target screening — literature notes",
        [
            h(1, "CRISPR off-target screening — literature notes"),
            p(
                `Reading for the grant methods section. Grouped by how the off-targets are detected.`,
            ),
            h(2, "In vitro selection"),
            ul([
                `${b("CIRCLE-seq")} — circularised genomic DNA, cut in vitro. Very sensitive, but it ` +
                    `over-calls: chromatin is not in the tube.`,
                `${b("SITE-seq")} — similar idea, biotin capture instead of circularisation.`,
            ]),
            h(2, "Cell-based"),
            ul([
                `${b("GUIDE-seq")} — dsODN tag integrated at the break. Closest to the real thing, ` +
                    `limited by transfection efficiency.`,
                `${b("DISCOVER-seq")} — tracks MRE11 recruitment by ChIP. Works in vivo, which none of ` +
                    `the others really do.`,
            ]),
            h(2, "What to actually run"),
            p(
                `For the liver work: ${mark("DISCOVER-seq as primary")}, CIRCLE-seq as the wide net, ` +
                    `then targeted amplicon sequencing on the union of the two candidate sets.`,
            ),
            quote(
                `The recurring finding across all four methods is that ${i("in vitro")} assays nominate ` +
                    `10–100× more sites than are ever cut in a cell. Treat their output as a candidate ` +
                    `list, never as a result.`,
            ),
            h(2, "To read"),
            tasks([
                [true, "Off-target landscape review, Nat Rev Genet 2025"],
                [true, "DISCOVER-seq in non-human primates"],
                [false, "Base editor off-target comparison (bookmarked, not read)"],
                [false, "The prime editing specificity preprint"],
            ]),
            p(
                `Search: ${link("PubMed — CRISPR off-target 2025", "https://pubmed.ncbi.nlm.nih.gov/")}`,
            ),
        ].join(""),
        { created: at(2026, 7, 14), updated: at(2026, 8, 30, 9, 5) },
        { icon: "📚" },
    );

    v.note(
        "note/stats-cheatsheet",
        research,
        "Statistics cheat sheet",
        [
            h(1, "Statistics cheat sheet"),
            p(`The handful of formulas I look up every single time.`),
            h(2, "Dispersion"),
            p(math("s^2 = \\frac{1}{n-1}\\sum_{i=1}^{n}(x_i - \\bar{x})^2", true)),
            p(
                `Standard error of the mean: ${math("SE = s/\\sqrt{n}")} — and the 95% CI is roughly ` +
                    `${math("\\bar{x} \\pm 1.96\\,SE")} once ${math("n > 30")}.`,
            ),
            h(2, "Which test"),
            table(
                ["Question", "Two groups", "More than two"],
                [
                    ["Normal, equal variance", "Student's t", "One-way ANOVA"],
                    ["Normal, unequal variance", "Welch's t", "Welch's ANOVA"],
                    ["Not normal", "Mann–Whitney U", "Kruskal–Wallis"],
                    ["Paired", "Paired t / Wilcoxon", "Repeated-measures ANOVA"],
                ],
            ),
            h(2, "Multiple comparisons"),
            p(
                `Bonferroni divides the threshold: ${math("\\alpha' = \\alpha/m")}. It is honest and ` +
                    `brutally conservative. Benjamini–Hochberg controls the false discovery rate instead — ` +
                    `sort the p-values and find the largest ${math("k")} with ` +
                    `${math("p_{(k)} \\le \\frac{k}{m}\\alpha")}.`,
            ),
            quote(
                `${b("The one that bites:")} a non-significant result is not evidence of no effect. ` +
                    `If that is the claim, the study needed an equivalence test and a power calculation ` +
                    `written down ${u("before")} the data came in.`,
            ),
        ].join(""),
        { created: at(2026, 3, 2), updated: at(2026, 7, 19, 10, 0) },
        { icon: "🧮" },
    );

    // ── Engineering ───────────────────────────────────────────────────────────
    v.note(
        "note/pg18-upgrade",
        runbooks,
        "PostgreSQL 18 upgrade runbook",
        [
            h(1, "PostgreSQL 18 upgrade runbook"),
            p(
                `${b("Target:")} 17.6 → 18.4, primary and both replicas. ` +
                    `${b("Window:")} Sunday 02:00–04:00 UTC. ${b("Expected downtime:")} under 8 minutes.`,
            ),
            quote(
                `${colored("Do not start without a verified base backup.", "#dc2626")} ` +
                    `"The nightly job said it succeeded" is not verification — restore it somewhere first.`,
            ),
            h(2, "Before the window"),
            tasks([
                [true, "Base backup restored into staging and queried"],
                [true, "Extension compatibility checked (pgvector, pg_stat_statements)"],
                [true, "Replica lag under 1 s for 24 h straight"],
                [false, "Announce the window in #status"],
            ]),
            h(2, "Steps"),
            ol([
                `Put the API into read-only mode: ${mono("fly secrets set DB_READONLY=1")}.`,
                "Wait for the write queue to drain (dashboard: Sync → pending pushes = 0).",
                "Stop the primary, run pg_upgrade with hard links.",
                "Start, run ANALYZE, then re-point the replicas.",
                "Flip read-only off and watch error rates for 15 minutes.",
            ]),
            code(
                "bash",
                `pg_upgrade \\
  --old-datadir=/var/lib/postgresql/17/main \\
  --new-datadir=/var/lib/postgresql/18/main \\
  --old-bindir=/usr/lib/postgresql/17/bin \\
  --new-bindir=/usr/lib/postgresql/18/bin \\
  --link --jobs=4 --check   # drop --check for the real run`,
            ),
            h(2, "Post-upgrade verification"),
            code(
                "sql",
                `-- planner statistics have to be rebuilt; --link does not carry them over
ANALYZE VERBOSE;

SELECT relname, n_live_tup, last_analyze
FROM pg_stat_user_tables
WHERE last_analyze IS NULL
ORDER BY n_live_tup DESC
LIMIT 20;`,
            ),
            h(2, "Rollback"),
            table(
                ["Failure point", "Action", "Recovery time"],
                [
                    ["pg_upgrade --check fails", "Abort, nothing changed", "0 min"],
                    [
                        "Upgrade fails mid-run",
                        "Start the old cluster, it is untouched with --link",
                        "~3 min",
                    ],
                    [
                        "Starts but queries regress",
                        "Re-point to a replica, upgrade it later",
                        "~10 min",
                    ],
                    ["Data corruption suspected", "Restore the base backup", "~90 min"],
                ],
            ),
            p(`Plan as circulated to the team:`),
            attachment(ID.pgPlan, "pg18-upgrade-plan.pdf", "application/pdf"),
        ].join(""),
        { created: at(2026, 8, 22), updated: at(2026, 9, 11, 8, 30) },
        { icon: "🔧", starred: true },
    );

    v.file(
        "file/pg18-plan",
        ID.pgUpgrade,
        "pg18-upgrade-plan.pdf",
        "application/pdf",
        simplePdf("PostgreSQL 18 upgrade — circulated plan", [
            "Window: Sunday 02:00-04:00 UTC",
            "Owner: platform on-call",
            "Expected downtime: under 8 minutes",
            "",
            "1. Read-only mode, drain the write queue",
            "2. pg_upgrade --link --jobs=4",
            "3. ANALYZE, re-point replicas",
            "4. Read-write, watch error rates for 15 minutes",
            "",
            "Rollback: the old cluster is untouched while --link is used.",
            "Escalation: platform on-call, then the database working group.",
        ]),
        { created: at(2026, 8, 25) },
        "The one-pager circulated before the change window",
    );

    v.note(
        "note/incident-2026-08-14",
        runbooks,
        "Incident 2026-08-14 — sync queue backlog",
        [
            h(1, "Incident 2026-08-14 — sync queue backlog"),
            p(
                `${b("Severity:")} SEV-2 · ${b("Duration:")} 3 h 12 min · ` +
                    `${b("Impact:")} pushes queued client-side; no data loss.`,
            ),
            h(2, "Timeline (UTC)"),
            table(
                ["Time", "Event"],
                [
                    ["09:41", "Deploy of the batch-push change goes out"],
                    ["09:58", "Queue depth alert fires; nobody is paged (threshold was warn-only)"],
                    ["11:20", "First user report: “saving forever”"],
                    ["11:34", "Incident opened, rollback started"],
                    ["11:52", "Rollback complete, queue begins draining"],
                    ["12:53", "Queue empty, incident closed"],
                ],
            ),
            h(2, "Cause"),
            p(
                `The batch endpoint began rejecting any batch containing a single oversized item, ` +
                    `instead of rejecting that item. One user's 9 MB note poisoned every batch it landed ` +
                    `in, and the client retried the same batch forever.`,
            ),
            code(
                "ts",
                `// before — one bad item fails the whole batch
if (items.some((item) => item.byte_size > MAX_ITEM_BYTES)) {
    throw new BadRequest("item too large");
}

// after — reject the item, accept the rest
const accepted = items.filter((item) => item.byte_size <= MAX_ITEM_BYTES);
const rejected = items.filter((item) => item.byte_size > MAX_ITEM_BYTES);
return { accepted: await upsert(accepted), rejected: rejected.map((i) => i.id) };`,
            ),
            quote(
                `${b("What made it a SEV-2 instead of a blip:")} the retry had no backoff cap, so the ` +
                    `clients kept the queue hot and hid the drain rate from the dashboard.`,
            ),
            h(2, "Actions"),
            tasks([
                [true, "Partial-failure response shape shipped"],
                [true, "Queue depth alert promoted to page"],
                [false, "Exponential backoff with a 5-minute ceiling on the client"],
                [false, "Add an oversized-item check before enqueueing, not after"],
            ]),
            h(2, "SLA impact"),
            p(`The quarter's SLA rollup, with this incident's 192 minutes in it:`),
            attachment(ID.slaMetrics, "sla-metrics.json", "application/json"),
        ].join(""),
        { created: at(2026, 8, 14, 13, 0), updated: at(2026, 10, 1, 8, 5) },
        { icon: "⚡" },
    );

    v.note(
        "note/decision-log",
        engineering,
        "Architecture decision log",
        [
            h(1, "Architecture decision log"),
            p(`Short entries. The reasoning matters more than the decision.`),
            table(
                ["#", "Decision", "Date", "Status"],
                [
                    [
                        "01",
                        "Fastify over Express — schema-first validation, faster JSON",
                        "2026-01-12",
                        "Accepted",
                    ],
                    [
                        "02",
                        "Drizzle over Prisma — no query engine binary, plain SQL escape hatch",
                        "2026-01-19",
                        "Accepted",
                    ],
                    [
                        "03",
                        "Hand-written migrations — generated diffs were unreliable",
                        "2026-02-03",
                        "Accepted",
                    ],
                    [
                        "04",
                        "Fractional index for ordering, not an integer column",
                        "2026-02-27",
                        "Accepted",
                    ],
                    [
                        "05",
                        "Server-side rendering for the app shell",
                        "2026-03-15",
                        "Superseded by 08",
                    ],
                    [
                        "08",
                        "Static SPA build — the shell has nothing to personalise",
                        "2026-05-02",
                        "Accepted",
                    ],
                ],
            ),
            h(2, "04 — why a fractional index"),
            p(
                `An integer ${mono("position")} column means every reorder rewrites the tail of the ` +
                    `list. With a string key you insert between two neighbours by generating a midpoint, ` +
                    `so a drag writes exactly ${b("one")} row. The cost is that the key is a string and ` +
                    `${mark("must never be parsed as a number")}.`,
            ),
            h(2, "03 — why migrations are hand-written"),
            p(
                `The generator's snapshots drifted from the real schema and it produced a large false ` +
                    `diff on every run. Writing the SQL by hand is slower per migration and far cheaper ` +
                    `per incident.`,
            ),
        ].join(""),
        { created: at(2026, 2, 3), updated: at(2026, 9, 5, 12, 15) },
        { icon: "🏗️" },
    );

    v.note(
        "note/onboarding-backend",
        engineering,
        "Onboarding — new backend engineer",
        [
            h(1, "Onboarding — new backend engineer"),
            p(
                `First week. Ask about anything on this list that does not work — it means it is stale.`,
            ),
            h(2, "Day 1 — environment"),
            tasks([
                [false, "Clone the repo and install with the pinned toolchain"],
                [false, "Bring up the dev database and run the migrations"],
                [false, "Green check and test runs locally"],
                [false, "Open a throwaway PR to confirm CI runs for you"],
            ]),
            code(
                "bash",
                `git clone git@example.com:platform/core.git && cd core
docker compose up -d db
./dev.sh          # API on :3000, client on :5173
./check.sh        # formatting, types, the UX gates
./test.sh         # unit + integration`,
            ),
            h(2, "Day 2–3 — read, do not write"),
            ol([
                `The schema and the migration folder, in order. It is the shortest honest history of the product.`,
                `The sync engine — pull, merge, conflict copies. Everything else is easier afterwards.`,
                `${noteLink(ID.adr, "Architecture decision log")}, top to bottom.`,
                `One closed incident, for instance ${noteLink(ID.incident, "Incident 2026-08-14")}.`,
            ]),
            h(2, "Day 4–5 — first change"),
            p(
                `Pick something with a test that fails first. ${i("Good first issues")} are labelled, ` +
                    `but honestly the best first change is a bug you hit yourself during setup.`,
            ),
            quote(
                `House rule: a pull request that changes behaviour changes the changelog too. ` +
                    `No exceptions, and it is the first thing review looks for.`,
            ),
        ].join(""),
        { created: at(2026, 4, 28), updated: at(2026, 8, 12, 9, 45) },
        { icon: "🎯" },
    );

    // ── Operations ────────────────────────────────────────────────────────────
    v.note(
        "note/q3-costs",
        operations,
        "Q3 platform costs",
        [
            h(1, "Q3 platform costs"),
            p(`All figures in EUR, excluding VAT. Source data:`),
            attachment(ID.costsCsv, "platform-costs-q3.csv", "text/csv"),
            image(ID.costChart, "cost-trend.png", COST_TREND_SIZE),
            h(2, "By line item"),
            table(
                ["Line item", "Jul", "Aug", "Sep", "Trend"],
                [
                    ["Compute (API + workers)", "3 180", "3 640", "3 470", "↗ +9%"],
                    ["Object storage", "1 490", "1 570", "1 690", "↗ +13%"],
                    ["Egress", "410", "455", "520", "↗ +27%"],
                    ["Managed Postgres", "890", "890", "890", "→ flat"],
                    ["Monitoring & logs", "260", "265", "610", "↗ +135%"],
                    [b("Total"), b("6 230"), b("6 820"), b("7 180"), b("↗ +15%")],
                ],
            ),
            h(2, "What actually moved"),
            ul([
                `${mark("Monitoring more than doubled in September")} — log retention was raised to 90 ` +
                    `days during the incident review and never put back. This is the cheapest thing to fix.`,
                `Egress is growing faster than storage, which means reads, not uploads. Worth checking ` +
                    `whether the cache headers on file downloads are doing anything at all.`,
                `Compute dipped in September because the batch-push change reduced request volume — ` +
                    `an unplanned win from ${noteLink(ID.incident, "Incident 2026-08-14")}.`,
            ]),
            h(2, "Actions"),
            tasks([
                [true, "Confirm the retention change was deliberate (it was not)"],
                [false, "Drop log retention back to 30 days"],
                [false, "Audit cache headers on the file download path"],
                [false, "Re-forecast Q4 with the corrected monitoring baseline"],
            ]),
        ].join(""),
        { created: at(2026, 9, 4), updated: at(2026, 9, 10, 17, 5) },
        { icon: "💼" },
    );

    v.file(
        "file/cost-trend",
        ID.costs,
        "cost-trend.png",
        "image/png",
        costTrendPng(),
        { created: at(2026, 9, 10, 16, 50) },
        "Monthly compute and storage spend",
    );

    v.file(
        "file/costs-csv",
        ID.costs,
        "platform-costs-q3.csv",
        "text/csv",
        encoder.encode(
            [
                "month,compute_eur,storage_eur,egress_eur,postgres_eur,monitoring_eur",
                "2026-01,2980,1180,290,890,240",
                "2026-02,3040,1220,305,890,245",
                "2026-03,2960,1265,300,890,250",
                "2026-04,3110,1310,340,890,250",
                "2026-05,3290,1375,365,890,255",
                "2026-06,3205,1430,380,890,260",
                "2026-07,3180,1490,410,890,260",
                "2026-08,3640,1570,455,890,265",
                "2026-09,3470,1690,520,890,610",
                "",
            ].join("\n"),
        ),
        { created: at(2026, 9, 4, 10, 0) },
        "Source data for the Q3 cost review",
    );

    v.file(
        "file/sla-metrics",
        ID.incident,
        "sla-metrics.json",
        "application/json",
        encoder.encode(
            `${JSON.stringify(
                {
                    period: "2026-Q3",
                    availability_target: 0.999,
                    availability_actual: 0.9982,
                    incidents: [
                        { id: "2026-08-14", severity: "SEV-2", minutes: 192, data_loss: false },
                        { id: "2026-07-02", severity: "SEV-3", minutes: 24, data_loss: false },
                    ],
                    latency_ms: { p50: 84, p95: 310, p99: 902 },
                    error_budget_remaining: 0.41,
                },
                null,
                2,
            )}\n`,
        ),
        { created: at(2026, 10, 1, 8, 0) },
        "Quarterly SLA rollup",
    );

    // ── Root ──────────────────────────────────────────────────────────────────
    v.note(
        "note/weekly-review",
        null,
        "Weekly review — 2026-09-07",
        [
            h(1, "Weekly review — 2026-09-07"),
            h(2, "Shipped"),
            ul([
                "Batch-push partial failures (closes the SEV-2 action item)",
                "Queue depth alert promoted to page",
                "Assay replicates for the 70 °C wild-type point re-run",
            ]),
            h(2, "Did not ship"),
            ul([
                `Exponential backoff — blocked on deciding the ceiling. ${i("Decide it on Monday.")}`,
                "Q4 cost forecast — waiting on the corrected monitoring baseline",
            ]),
            h(2, "Next week"),
            tasks([
                [
                    false,
                    `Run the ${noteLink(ID.pgUpgrade, "PostgreSQL 18 upgrade runbook")} on staging end to end`,
                ],
                [false, "Repeat the thermostability assay at pH 4.0"],
                [false, "Read the two remaining CRISPR papers"],
                [false, "Drop log retention to 30 days"],
            ]),
            hr,
            p(
                `${i("Observation:")} two of the four things that slipped were blocked on a decision ` +
                    `nobody owned, not on work. That is the pattern to fix.`,
                "center",
            ),
        ].join(""),
        { created: at(2026, 9, 7, 17, 0), updated: at(2026, 9, 7, 17, 40) },
        { icon: "📅" },
    );

    v.note(
        "note/tour",
        null,
        "Start here — demo vault tour",
        [
            h(1, "Start here"),
            p(
                `This vault is ${b("test data")}. It was generated by ` +
                    `${mono("scripts/make-demo-vault.ts")} and imported through Settings → Backup & ` +
                    `Export → Restore. Delete it whenever you like and import it again.`,
            ),
            hr,
            h(2, "What is in here"),
            table(
                ["Folder", "Contains"],
                [
                    [
                        "🔬 Research",
                        "Lab protocols, an assay log with a figure, literature notes, formulas",
                    ],
                    [
                        "💻 Engineering",
                        "A database upgrade runbook, an incident write-up, a decision log",
                    ],
                    [
                        "📊 Operations",
                        "A cost review with a chart, plus the CSV and JSON behind it",
                    ],
                ],
            ),
            h(2, "Editor features it exercises"),
            ul([
                `Headings, ${b("bold")}, ${i("italic")}, ${u("underline")}, ${strike("strikethrough")}, ` +
                    `${mono("inline code")}, ${mark("highlight")} and ${colored("coloured text", "#7c3aed")}`,
                `Subscript and superscript: H${sub("2")}O, 10${sup("-9")} M`,
                `KaTeX, inline ${math("e^{i\\pi} + 1 = 0")} and as a block`,
                "Task lists, tables, code blocks, block quotes, horizontal rules",
                "Attachments, both inline in a note and standing on their own in a folder",
                `Note-to-note links, like ${noteLink(ID.thermostability, "Thermostability of β-glucosidase")}`,
            ]),
            h(2, "Good things to try"),
            tasks([
                [
                    false,
                    `Press ${mono("Cmd/Ctrl+K")} and type ${mono("stg")} — fuzzy search finds it`,
                ],
                [false, "Open the assay log and click the heatmap"],
                [false, "Colour a folder and give it an emoji from the context menu"],
                [false, "Export a backup of this vault and compare it with the generated one"],
                [true, "Read this note"],
            ]),
            quote(
                `Nothing in here is real. The measurements, the incident and the invoices are all ` +
                    `invented for testing.`,
            ),
        ].join(""),
        { created: at(2026, 9, 12, 8, 0), updated: at(2026, 9, 12, 8, 0) },
        { icon: "🌟", starred: true },
    );

    v.file(
        "file/readme",
        null,
        "README.md",
        "text/markdown",
        encoder.encode(
            [
                "# Demo vault",
                "",
                "Generated by `scripts/make-demo-vault.ts` in the ZKnotes repository.",
                "",
                "Import: Settings -> Backup & Export -> Restore from backup, pick `demo-vault.zip`.",
                "",
                "Everything in this vault is invented test data.",
                "",
            ].join("\n"),
        ),
        { created: at(2026, 9, 12, 8, 0) },
        "How this vault got here",
    );

    return { items: v.items, files: v.files };
}
