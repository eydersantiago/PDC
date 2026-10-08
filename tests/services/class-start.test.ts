import assert from "node:assert/strict";
import test from "node:test";
import { parseClassGpuVms, resolveClassStartConfig } from "../../src/services/class-start.js";

/**
 * «Iniciar clase» (navegador 0.7.21): configuracion desde el entorno, sin red.
 * El encendido con un Compute falso se prueba en tests/routes/class-routes.test.ts.
 */

test("clase: CLASS_GPU_VMS es nombre:zona en orden, sin repetidos; las entradas malas se dicen", () => {
  assert.deepEqual(parseClassGpuVms(""), { gpus: [], problem: "" });
  const parsed = parseClassGpuVms(" adaceen-worker-v100:us-central1-b, adaceen-worker-a100:us-central1-c ,adaceen-worker:us-central1-a,adaceen-worker-v100:us-central1-b");
  assert.deepEqual(parsed.gpus, [
    { name: "adaceen-worker-v100", zone: "us-central1-b" },
    { name: "adaceen-worker-a100", zone: "us-central1-c" },
    { name: "adaceen-worker", zone: "us-central1-a" },
  ]);
  assert.equal(parsed.problem, "");
  const bad = parseClassGpuVms("adaceen-worker-v100,adaceen-worker-a100:us-central1-c,Mayus:zona,a:b:c");
  assert.deepEqual(bad.gpus, [{ name: "adaceen-worker-a100", zone: "us-central1-c" }]);
  assert.match(bad.problem, /adaceen-worker-v100/);
  assert.match(bad.problem, /Mayus:zona/);
  assert.match(bad.problem, /a:b:c/);
});

test("clase: sin VMs no hay nada configurado; con GPU o VM de editores hace falta el proyecto", () => {
  assert.deepEqual(resolveClassStartConfig({}), { config: null, problem: "" });
  assert.deepEqual(resolveClassStartConfig({ project: "adaceen-piloto" }), { config: null, problem: "" });

  const noProject = resolveClassStartConfig({ gpus: "adaceen-worker:us-central1-a" });
  assert.equal(noProject.config, null);
  assert.match(noProject.problem, /WORKSPACE_VM_PROJECT/);

  const onlyGpu = resolveClassStartConfig({ project: "adaceen-piloto", gpus: "adaceen-worker:us-central1-a" });
  assert.deepEqual(onlyGpu, { config: { project: "adaceen-piloto", gpus: [{ name: "adaceen-worker", zone: "us-central1-a" }], editors: null }, problem: "" });

  const onlyEditors = resolveClassStartConfig({ project: "adaceen-piloto", zone: "us-central1-a", name: "adaceen-ws" });
  assert.deepEqual(onlyEditors.config, { project: "adaceen-piloto", gpus: [], editors: { name: "adaceen-ws", zone: "us-central1-a" } });

  // Una entrada mala no apaga el resto: se avisa y siguen las buenas.
  const partly = resolveClassStartConfig({ project: "adaceen-piloto", zone: "us-central1-a", name: "adaceen-ws", gpus: "rota,adaceen-worker:us-central1-a" });
  assert.equal(partly.config?.gpus.length, 1);
  assert.match(partly.problem, /rota/);
});
