import assert from "node:assert/strict";
import test from "node:test";
import { listListeningWorkers, recordWorkerHeartbeat, resetWorkerHeartbeatsForTests } from "../../src/services/worker-heartbeat.js";

test("latido: una Mac del laboratorio informa plataforma, concurrencia y tipos, y se muestra como tal", () => {
  resetWorkerHeartbeatsForTests();
  const now = Date.now();
  recordWorkerHeartbeat({ workerId: "mac-lab01-m2", model: "qwen2.5-coder:14b", platform: "darwin-arm64", concurrency: 2, kinds: "text" }, now);
  recordWorkerHeartbeat({ workerId: "gce-v100", model: "qwen2.5-coder:14b", platform: "linux-x64; rm -rf", concurrency: 0 }, now);
  const workers = listListeningWorkers(now);
  const mac = workers.find((worker) => worker.id === "mac-lab01-m2");
  assert.ok(mac);
  assert.equal(mac.label, "Mac del laboratorio - M2");
  assert.equal(mac.provider, "mac");
  assert.equal(mac.platform, "darwin-arm64");
  assert.equal(mac.concurrency, 2);
  assert.equal(mac.kinds, "text");
  const gpu = workers.find((worker) => worker.id === "gce-v100");
  assert.equal(gpu?.platform, "linux-x64rm-rf", "solo letras, numeros, guion y guion bajo");
  assert.equal(gpu?.concurrency, null);
  resetWorkerHeartbeatsForTests();
});

test("latido: la Mac coordinadora de un cluster de Mac se muestra como cluster", async () => {
  const { describeWorker } = await import("../../src/services/worker-identity.js");
  assert.equal(describeWorker("mac-lab-cluster-m2").label, "Clúster de Mac del laboratorio - M2");
  assert.equal(describeWorker("mac-lab-cluster07-m1pro").label, "Clúster de Mac del laboratorio - M1PRO");
  assert.equal(describeWorker("mac-lab07-m2").label, "Mac del laboratorio - M2");
});
