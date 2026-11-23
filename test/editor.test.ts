import { describe, expect, it } from "vitest";
import { firstSentences, reconcile, screenOverview, staleTerms, type Plan } from "../src/agent/editor.js";
import { Harness, decision } from "./helpers.js";

function base() {
  return new Harness()
    .apply("record_item", decision("dec-redis", "rejected", "00:00:30", "What if we used Redis", { title: "Session store: Redis" }))
    .apply("record_item", decision("dec-postgres", "accepted", "00:05:30", "Agreed, Postgres for sessions", { title: "Session store: Postgres" }))
    .apply("upsert_component", { id: "cmp-api", name: "API", type: "service", description: "Serves requests.", basis: ["dec-postgres"] })
    .apply("upsert_component", { id: "cmp-cache", name: "Cache", type: "datastore", description: "Old cache.", basis: ["dec-postgres"] })
    .apply("upsert_edge", { from: "cmp-api", to: "cmp-cache", label: "read", basis: ["dec-postgres"] });
}

const plan = (p: Partial<Plan>): Plan => ({ components: [], edges: [], overview: "", ...p });

describe("editor reconcile", () => {
  it("emits only the difference between the plan and the current diagram", () => {
    const h = base();
    const ops = reconcile(
      h.state,
      plan({
        components: [
          { id: "cmp-api", name: "API", type: "service", description: "Serves requests.", basis: ["dec-postgres"] },
          { id: "cmp-db", name: "Postgres", type: "datastore", description: "Sessions.", basis: ["dec-postgres"] },
        ],
        edges: [{ from: "cmp-api", to: "cmp-db", label: "read sessions", basis: ["dec-postgres"] }],
        overview: "Sessions live in Postgres.",
      }),
    );
    expect(ops.map((o) => `${o.name}:${"id" in o.input ? o.input.id : ""}`)).toEqual([
      "upsert_component:cmp-db",
      "remove_component:cmp-cache",
      "upsert_edge:",
      "set_overview:",
    ]);
    // Unchanged component produced no op; the cache edge goes with its component.
    for (const op of ops) h.state = (h.try(op.name, op.input as never, "editor") as { ok: true; state: typeof h.state }).state;
    expect(h.state.components["cmp-cache"]!.removed).toBe(true);
    expect(h.state.edges["cmp-api->cmp-cache"]!.removed).toBe(true);
    expect(h.state.meeting.overview).toBe("Sessions live in Postgres.");
  });

  it("is idempotent: applying the same plan twice changes nothing the second time", () => {
    const h = base();
    const p = plan({
      components: [{ id: "cmp-api", name: "API", type: "service", description: "Serves requests.", basis: ["dec-postgres"] }],
      overview: "x",
    });
    for (const op of reconcile(h.state, p)) h.apply(op.name, op.input as never, "editor");
    expect(reconcile(h.state, p)).toEqual([]);
  });

  it("drops unknown basis ids, components without basis, and edges to missing components", () => {
    const h = base();
    const ops = reconcile(
      h.state,
      plan({
        components: [
          { id: "API", name: "API", type: "service", description: "Serves requests.", basis: ["dec-postgres", "dec-ghost"] },
          { id: "cmp-ghost", name: "Ghost", type: "service", description: "x", basis: ["dec-ghost"] },
        ],
        edges: [{ from: "cmp-api", to: "cmp-ghost", label: "x", basis: ["dec-postgres"] }],
      }),
    );
    const names = ops.map((o) => o.name);
    expect(names).not.toContain("upsert_edge");
    expect(ops.find((o) => o.name === "upsert_component")).toBeUndefined(); // cmp-api unchanged after filtering
    expect(names.filter((n) => n === "remove_component")).toHaveLength(1); // cmp-cache
  });
});

describe("diagram stability", () => {
  it("keeps the id of a component the editor re-ids under the same name, and its edges follow", () => {
    const h = base();
    const ops = reconcile(
      h.state,
      plan({
        components: [
          { id: "cmp-api", name: "API", type: "service", description: "Serves requests.", basis: ["dec-postgres"] },
          { id: "cmp-cache-2", name: "cache", type: "datastore", description: "Old cache.", basis: ["dec-postgres"] },
        ],
        edges: [{ from: "cmp-api", to: "cmp-cache-2", label: "read", basis: ["dec-postgres"] }],
      }),
    );
    expect(ops.filter((o) => o.name !== "set_overview")).toEqual([
      { name: "upsert_component", input: { id: "cmp-cache", name: "cache", type: "datastore", description: "Old cache.", basis: ["dec-postgres"] } },
    ]);
  });

  it("does not drop a component whose decision is still live just because one plan forgot it", () => {
    const h = base().apply("record_item", decision("dec-queue", "accepted", "00:08:20", "I'll write the migration plan by Friday", { title: "Migration worker" }));
    h.apply("upsert_component", { id: "cmp-queue", name: "SQS queue", type: "queue", description: "Jobs.", basis: ["dec-queue"] });
    const forgot = plan({
      components: [
        { id: "cmp-api", name: "API", type: "service", description: "Serves requests.", basis: ["dec-postgres"] },
        { id: "cmp-cache", name: "Cache", type: "datastore", description: "Old cache.", basis: ["dec-postgres"] },
      ],
      edges: [{ from: "cmp-api", to: "cmp-cache", label: "read", basis: ["dec-postgres"] }],
    });
    expect(reconcile(h.state, forgot).map((o) => o.name)).not.toContain("remove_component");
    // Once the decision is replaced, the component may go.
    h.apply("update_item", { id: "dec-queue", status: "rejected", reason: "turned down", ts: "00:08:20", quote: "I'll write the migration plan by Friday" });
    expect(reconcile(h.state, forgot).map((o) => `${o.name}:${"id" in o.input ? o.input.id : ""}`)).toContain("remove_component:cmp-queue");
  });
});

describe("overview screening", () => {
  it("finds terms that only belong to rejected or superseded options", () => {
    expect(staleTerms(base().state)).toContain("redis");
    expect(staleTerms(base().state)).not.toContain("session");
  });

  it("drops sentences that mention a stale option", () => {
    const out = screenOverview("Sessions live in Postgres. Redis was considered first. Retention is open.", ["redis"]);
    expect(out).toBe("Sessions live in Postgres. Retention is open.");
  });

  it("keeps dotted tokens (H.264, 1.4x, v1.2) inside their sentence", () => {
    expect(screenOverview("Workers encode H.264 at 1.4x speed. Kafka was considered. Next is v1.2.", ["kafka"])).toBe("Workers encode H.264 at 1.4x speed. Next is v1.2.");
    expect(firstSentences("Workers use H.264. Next. Third.", 2, 200)).toBe("Workers use H.264. Next.");
  });
});
