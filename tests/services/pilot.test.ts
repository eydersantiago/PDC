import assert from "node:assert/strict";
import test from "node:test";
import {
  assignPilotCohorts,
  pilotConditionFor,
  pilotStateFor,
  seededRandom,
} from "../../src/services/pilot.js";

/** A13.1: diseno AB/BA, condiciones por bloque y asignacion balanceada reproducible. */

test("piloto: la cohorte A empieza con tutor y la B sin tutor; fuera del piloto no hay condicion", () => {
  assert.equal(pilotConditionFor("A", 1), "con_tutor");
  assert.equal(pilotConditionFor("B", 1), "sin_tutor");
  assert.equal(pilotConditionFor("A", 2), "sin_tutor");
  assert.equal(pilotConditionFor("B", 2), "con_tutor");
  assert.equal(pilotConditionFor("A", 0), "");
  assert.equal(pilotConditionFor("", 1), "");
  assert.equal(pilotConditionFor(null, 2), "");
  assert.deepEqual(pilotStateFor("b", 2), { block: 2, cohort: "B", condition: "con_tutor" });
  assert.deepEqual(pilotStateFor("A", 7), { block: 0, cohort: "A", condition: "" });
});

test("piloto: la asignacion es balanceada y se reproduce con la misma semilla", () => {
  const students = Array.from({ length: 7 }, (_, index) => `est-${index + 1}`);
  const first = assignPilotCohorts({ studentUserIds: students, existing: [], seed: "grupo-1:2026-10-01" });
  const again = assignPilotCohorts({ studentUserIds: [...students].reverse(), existing: [], seed: "grupo-1:2026-10-01" });
  assert.equal(first.assignments.length, 7);
  assert.ok(Math.abs(first.counts.A - first.counts.B) <= 1, "cohortes balanceadas");
  assert.deepEqual(
    [...first.assignments].sort((a, b) => a.studentUserId.localeCompare(b.studentUserId)),
    [...again.assignments].sort((a, b) => a.studentUserId.localeCompare(b.studentUserId)),
    "el orden de la lista no cambia el resultado",
  );

  const seeds = new Set<string>();
  for (let seed = 0; seed < 20; seed += 1) {
    const result = assignPilotCohorts({ studentUserIds: students, existing: [], seed: `semilla-${seed}` });
    seeds.add(result.assignments.filter((item) => item.cohort === "A").map((item) => item.studentUserId).sort().join(","));
  }
  assert.ok(seeds.size > 5, "distintas semillas dan asignaciones distintas");
});

test("piloto: los que ya tienen cohorte no cambian y los nuevos van a la cohorte mas pequena", () => {
  const existing = [
    { studentUserId: "est-1", cohort: "A" as const },
    { studentUserId: "est-2", cohort: "A" as const },
    { studentUserId: "est-3", cohort: "B" as const },
  ];
  const result = assignPilotCohorts({
    studentUserIds: ["est-1", "est-2", "est-3", "est-4", "retirado-no-esta"].slice(0, 4),
    existing,
    seed: "x",
  });
  assert.deepEqual(result.added, [{ studentUserId: "est-4", cohort: "B" }]);
  assert.deepEqual(result.counts, { A: 2, B: 2 });

  const reset = assignPilotCohorts({ studentUserIds: ["est-1", "est-2", "est-3", "est-4"], existing, seed: "x", reset: true });
  assert.equal(reset.added.length, 4);
  assert.deepEqual(reset.counts, { A: 2, B: 2 });
});

test("piloto: el generador con semilla es determinista y queda en [0, 1)", () => {
  const a = seededRandom("abc");
  const b = seededRandom("abc");
  for (let index = 0; index < 50; index += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});
