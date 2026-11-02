import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../../src/config/env.js";
import { createClassStarter, type ClassContext } from "../../src/services/class-start.js";
import { createComputeClient } from "../../src/services/gcp-compute.js";
import { describeGpuAutostart, requestGpuStart, resetGpuAutostartForTests, setGpuStarterProvider } from "../../src/services/gpu-autostart.js";
import type { FetchLike } from "../../src/services/workspace-provider.js";

/**
 * Seguimiento del autoencendido (incidente del 1-11-2026): Compute acepta el start de la primera GPU
 * pero la VM no enciende (sin L4 en la zona). El backend tiene que probar la siguiente de
 * CLASS_GPU_VMS solo, sin esperar a que el estudiante vuelva a preguntar.
 */

type FakeVm = { status: string; startStatus: number; startsTo?: string };

// Compute falso: estado por VM y los POST de start, en orden.
function fakeCompute(vms: Record<string, FakeVm>) {
  const posts: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const match = url.match(/\/zones\/([^/]+)\/instances\/([^/]+)(\/start)?$/);
    assert.ok(match, `URL de Compute inesperada: ${url}`);
    const [, , name, start] = match;
    const vm = vms[name];
    if (start) {
      posts.push(name);
      if (vm.startStatus < 300) vm.status = vm.startsTo || "STAGING";
      const body = vm.startStatus < 300 ? { status: "RUNNING" } : { error: { code: vm.startStatus, message: "sin cupo", errors: [{ reason: "ZONE_RESOURCE_POOL_EXHAUSTED" }] } };
      return new Response(JSON.stringify(body), { status: vm.startStatus });
    }
    return new Response(JSON.stringify({ name, status: vm.status }), { status: 200 });
  };
  return { vms, posts, fetchImpl };
}

/**
 * Las dos L4 del incidente. El reloj del encendedor lo mueve la prueba (el temporizador del
 * seguimiento es real: startFailAfterMs de 40 ms lo dispara a los 80 ms).
 */
function setup(vms: Record<string, FakeVm>, context: ClassContext = { provider: "codespaces", agentOnline: null, workersAlive: 0 }) {
  const compute = fakeCompute(vms);
  const clock = { now: Date.parse("2026-11-01T11:00:00Z") };
  const starter = createClassStarter(
    { project: "adaceen-piloto", gpus: [{ name: "adaceen-worker-b", zone: "us-central1-a" }, { name: "adaceen-worker", zone: "us-west4-c" }], editors: null },
    {
      compute: createComputeClient({ getAccessToken: async () => "token-falso", fetch: compute.fetchImpl }),
      context: async () => ({ ...context }),
      now: () => clock.now,
      startFailAfterMs: 40,
    },
  );
  setGpuStarterProvider(() => ({ starter, problem: "" }));
  return { compute, clock, context };
}

async function until(condition: () => boolean, ms = 3000) {
  const limit = Date.now() + ms;
  while (!condition() && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 10));
  return condition();
}

async function withAutostart(work: () => Promise<void>) {
  const original = env.gpuAutostart;
  const info = console.info;
  const warn = console.warn;
  env.gpuAutostart = "on";
  console.info = () => undefined;
  console.warn = () => undefined;
  resetGpuAutostartForTests();
  try {
    await work();
  } finally {
    resetGpuAutostartForTests();
    setGpuStarterProvider(null);
    env.gpuAutostart = original;
    console.info = info;
    console.warn = warn;
  }
}

test("autoencendido: si la primera GPU acepto el start pero no quedo encendida, el seguimiento prueba la segunda sin otro pedido", async () => {
  await withAutostart(async () => {
    const { compute, clock } = setup({
      // Compute acepta el start y la VM sigue TERMINATED (sin L4 en la zona).
      "adaceen-worker-b": { status: "TERMINATED", startStatus: 200, startsTo: "TERMINATED" },
      "adaceen-worker": { status: "TERMINATED", startStatus: 200 },
    });
    const first = await requestGpuStart("pedido de texto sin servidor vivo");
    assert.equal(first?.state, "starting");
    assert.equal(first?.vm, "adaceen-worker-b");
    assert.deepEqual(compute.posts, ["adaceen-worker-b"]);
    assert.equal(describeGpuAutostart().last_attempt?.vm, "adaceen-worker-b");

    // Pasan los 90 s (aqui 40 ms) sin que nadie vuelva a preguntar.
    clock.now += 100_000;
    assert.ok(await until(() => compute.posts.length === 2), `posts: ${compute.posts.join(", ")}`);
    assert.deepEqual(compute.posts, ["adaceen-worker-b", "adaceen-worker"]);
    assert.ok(await until(() => describeGpuAutostart().last_attempt?.vm === "adaceen-worker"));
    const attempt = describeGpuAutostart().last_attempt!;
    assert.equal(attempt.ok, true);
    assert.match(attempt.reason, /seguimiento del autoencendido/);
    assert.match(attempt.detail, /instances\.start adaceen-worker aceptado/);

    // El siguiente pedido del estudiante (pasada la cache de 20 s o no) no enciende otra: ya hay una arrancando.
    const again = await requestGpuStart("pedido de texto sin servidor vivo", Date.now() + 60_000);
    assert.equal(again?.state, "starting");
    assert.equal(again?.vm, "adaceen-worker");
    assert.equal(compute.posts.length, 2);
  });
});

test("autoencendido: el seguimiento no hace nada si la GPU encendio, si ya hay servidor o si GPU_AUTOSTART se apago", async () => {
  // La primera encendio: el seguimiento la ve RUNNING y no enciende otra ni cambia last_attempt.
  await withAutostart(async () => {
    const { compute, clock } = setup({
      "adaceen-worker-b": { status: "TERMINATED", startStatus: 200, startsTo: "RUNNING" },
      "adaceen-worker": { status: "TERMINATED", startStatus: 200 },
    });
    await requestGpuStart("pedido de texto sin servidor vivo");
    const before = describeGpuAutostart().last_attempt;
    clock.now += 100_000;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(compute.posts, ["adaceen-worker-b"]);
    assert.deepEqual(describeGpuAutostart().last_attempt, before);
  });

  // Un servidor del modelo (una Mac del laboratorio) ya atiende: no enciende la segunda GPU.
  await withAutostart(async () => {
    const { compute, clock, context } = setup({
      "adaceen-worker-b": { status: "TERMINATED", startStatus: 200, startsTo: "TERMINATED" },
      "adaceen-worker": { status: "TERMINATED", startStatus: 200 },
    });
    await requestGpuStart("pedido de texto sin servidor vivo");
    context.workersAlive = 1;
    clock.now += 100_000;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(compute.posts, ["adaceen-worker-b"]);
  });

  // GPU_AUTOSTART apagado antes del seguimiento: nada.
  await withAutostart(async () => {
    const { compute, clock } = setup({
      "adaceen-worker-b": { status: "TERMINATED", startStatus: 200, startsTo: "TERMINATED" },
      "adaceen-worker": { status: "TERMINATED", startStatus: 200 },
    });
    await requestGpuStart("pedido de texto sin servidor vivo");
    env.gpuAutostart = "off";
    clock.now += 100_000;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(compute.posts, ["adaceen-worker-b"]);
  });
});

test("autoencendido: si la segunda tampoco tiene cupo, el seguimiento deja en /api/health por que no encendio ninguna", async () => {
  await withAutostart(async () => {
    const { compute, clock } = setup({
      "adaceen-worker-b": { status: "TERMINATED", startStatus: 200, startsTo: "TERMINATED" },
      "adaceen-worker": { status: "TERMINATED", startStatus: 403 },
    });
    await requestGpuStart("pedido de texto sin servidor vivo");
    clock.now += 100_000;
    assert.ok(await until(() => describeGpuAutostart().last_attempt?.ok === false));
    assert.deepEqual(compute.posts, ["adaceen-worker-b", "adaceen-worker"]);
    const attempt = describeGpuAutostart().last_attempt!;
    assert.match(attempt.reason, /seguimiento del autoencendido/);
    assert.match(attempt.detail, /adaceen-worker-b: Compute acepto el encendido pero la VM sigue apagada/);
    assert.match(attempt.detail, /ZONE_RESOURCE_POOL_EXHAUSTED|sin cupo/);
  });
});
