import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePilotMonitor,
  formatPilotMonitorFields,
  formatPilotMonitorLine,
  monitorWindows,
  type PilotMonitorInput,
} from "../../src/services/pilot-monitor.js";

/**
 * Reglas del monitor del piloto (A14.2), compartidas por npm run piloto:monitor y la
 * pagina /docente/monitor: cada alerta sale con su texto exacto, el resumen trae lo
 * que pinta la pagina y la linea de consola conserva su forma.
 */

function kpis(values: Partial<Record<"T1" | "T3" | "T4" | "T5", { value: number | null; meets: boolean | null }>>) {
  return Object.entries(values).map(([id, item]) => ({ id, value: item.value, n: 10, meets: item.meets }));
}

function healthyInput(): PilotMonitorInput {
  return {
    health: { status: 200, data: { ok: true, alive_workers: 1 } },
    backendHealth: { status: 200, data: { ok: true, mode: "queue", workspace_provider: "tunnel", workspace_agent_online: true, workspace_agent_transport: "relay", workspace_vm_autostart: true } },
    pilot: { status: 200, data: { block: 0, description: "Sin bloque", counts: { A: 2, B: 2, sinAsignar: 0 } } },
    session: { status: 200, data: { ok: true, activity: { events: 12, students: 4, studentsByCondition: { con_tutor: 2, sin_tutor: 2 }, anonymousClientSessions: 0, lastEventAt: "2026-10-08T14:00:00.000Z" }, kpis: kpis({ T1: { value: 4.25, meets: true }, T3: { value: 100, meets: true }, T4: { value: 0, meets: true }, T5: { value: 0, meets: true } }) } },
    window10: { status: 200, data: { ok: true, activity: { events: 5, students: 3, studentsByCondition: { con_tutor: 2, sin_tutor: 1 }, anonymousClientSessions: 0, lastEventAt: null }, kpis: kpis({ T1: { value: 3.5, meets: true } }) } },
    window5: { status: 200, data: { ok: true, activity: { events: 3, students: 2, studentsByCondition: { con_tutor: 1, sin_tutor: 1 }, anonymousClientSessions: 0, lastEventAt: null }, kpis: [] } },
    inference: {
      status: 200,
      data: {
        mode: "queue",
        worker: { id: "gce-v100", label: "Google Cloud - V100", accelerator: "V100", observedAt: "2026-10-08T13:59:00.000Z" },
        listening: [
          { id: "gce-v100", label: "Google Cloud - V100", alive: true, kinds: "text,image", model: "qwen2.5-coder:14b", platform: "linux-x64", lastSeenAt: "2026-10-08T14:00:10.000Z", jobsProcessed: 7 },
          { id: "mac-lab02-m2", label: "Mac del laboratorio - M2", alive: false, kinds: "text", model: "qwen2.5-coder:14b" },
        ],
      },
    },
  };
}

test("monitor del piloto: sin problemas no hay alertas y el resumen trae lo que pinta la pagina", () => {
  const now = new Date("2026-10-08T14:00:30.000Z");
  const { resumen, alertas, quietSince } = evaluatePilotMonitor(healthyInput(), { now });
  assert.deepEqual(alertas, []);
  assert.equal(quietSince, null);
  assert.deepEqual(resumen.backend, { responde: true, estado: 200, modo: "queue" });
  assert.deepEqual(resumen.worker, { ok: true, estado: 200, vivos: 1 });
  assert.equal(resumen.modelo.servidoresVivos, 1, "solo cuenta los servidores con latido vigente");
  assert.equal(resumen.modelo.texto, "servidores 1 (Google Cloud - V100 x1)");
  assert.deepEqual(resumen.modelo.porTipo, [{ etiqueta: "Google Cloud - V100", cantidad: 1 }]);
  assert.equal(resumen.modelo.aceptaImagenes, true);
  assert.deepEqual(resumen.modelo.modelos, ["qwen2.5-coder:14b"]);
  assert.deepEqual(resumen.modelo.servidores.map((server) => server.id), ["gce-v100"]);
  assert.equal(resumen.modelo.servidores[0].jobs, 7);
  assert.deepEqual(resumen.modelo.ultimoAtendio, { id: "gce-v100", etiqueta: "Google Cloud - V100", vistoEn: "2026-10-08T13:59:00.000Z" });
  assert.deepEqual(resumen.editor, { proveedor: "tunnel", agenteConectado: true, autoencendido: true, transporte: "relay" });
  assert.deepEqual(resumen.piloto, { bloque: 0, descripcion: "Sin bloque", conteos: { A: 2, B: 2, sinAsignar: 0 }, estado: 200 });
  assert.deepEqual(resumen.estudiantes, { activos5min: 2, porCondicion: { con_tutor: 1, sin_tutor: 1 }, eventosSesion: 12, sinUsuario: 0, ultimoEvento: "2026-10-08T14:00:00.000Z" });
  assert.deepEqual(resumen.calidad, {
    latenciaP50Reciente: 3.5,
    sinFallo: 100,
    perdidos: 0,
    duplicados: 0,
    cumple: { sinFallo: true, perdidos: true, duplicados: true },
  });
  // La linea de consola, igual que antes de compartir las reglas con la pagina.
  const line = formatPilotMonitorLine(resumen, now);
  // La hora es la local (es-CO): fuera de UTC puede tener un digito (9:00:30 en Bogota).
  assert.match(line, /^\d{1,2}:\d{2}:\d{2} \| bloque 0 \| worker ok \| servidores 1 \(Google Cloud - V100 x1\) \| activos 5 min 2 \(con tutor 1, sin tutor 1\) \| p50 10 min 3,5 s \| sin fallo 100 % \| perdidos 0 % \| eventos 12$/);
  assert.equal(line.split(" | ").slice(1).join(" | "), formatPilotMonitorFields(resumen).join(" | "));
});

test("monitor del piloto: cada regla produce su alerta con el texto del script", () => {
  const now = new Date("2026-10-08T14:00:30.000Z");
  const input = healthyInput();
  input.health = { status: 503, data: { ok: false, reason: "sin_worker", alive_workers: 0 } };
  input.backendHealth = { status: 0, data: { error: "fetch failed" } };
  input.inference.data.listening = [
    { id: "gce-v100", label: "Google Cloud - V100", alive: true, kinds: "text", model: "qwen2.5-coder:14b" },
    { id: "mac-lab01-m2", label: "Mac del laboratorio - M2", alive: true, kinds: "text", model: "qwen2.5-coder:7b" },
  ];
  input.pilot.data = { block: 1, description: "Bloque 1", counts: { A: 1, B: 1, sinAsignar: 3 } };
  input.window10.data.kpis = kpis({ T1: { value: 9.5, meets: false } });
  input.session.data.kpis = kpis({ T3: { value: 90, meets: false }, T4: { value: 3.2, meets: false }, T5: { value: 1.5, meets: false } });
  input.session.data.activity!.anonymousClientSessions = 2;
  input.window5.data.activity!.students = 0;
  input.window5.data.activity!.studentsByCondition = {};

  const first = evaluatePilotMonitor(input, { now });
  assert.deepEqual(first.alertas, [
    "sin worker (agent/health 503): el tutor responde degradado",
    "el backend no responde (/api/health)",
    "servidores con modelos distintos (qwen2.5-coder:14b, qwen2.5-coder:7b): las respuestas no son comparables",
    "ningun servidor vivo acepta imagenes (QUEUE_WORKER_KINDS): las preguntas con captura esperan hasta el timeout",
    "latencia p50 de 10 min en 9,5 s (> 8 s)",
    "respuestas sin fallo 90 % (< 95 %)",
    "eventos perdidos 3,2 % (> 2 %)",
    "duplicados 1,5 % (> 1 %)",
    "2 sesiones de cliente sin usuario: revisa la sesion compartida de VS Code",
    "3 estudiantes sin cohorte",
  ]);
  // Bloque activo sin estudiantes: la primera lectura solo anota desde cuando; a los 5 min, alerta.
  assert.equal(first.quietSince, now.getTime());
  assert.equal(first.resumen.backend.responde, false);
  assert.equal(first.resumen.editor.proveedor, null, "sin /api/health no se sabe el entorno");
  const later = evaluatePilotMonitor(input, { now: new Date(now.getTime() + 5 * 60_000), quietSince: first.quietSince });
  assert.ok(later.alertas.includes("bloque activo y ningun estudiante con eventos en 5 min"));
  assert.equal(later.quietSince, now.getTime());
  // Vuelve un estudiante: se olvida el silencio.
  input.window5.data.activity!.students = 1;
  const back = evaluatePilotMonitor(input, { now: new Date(now.getTime() + 6 * 60_000), quietSince: later.quietSince });
  assert.equal(back.quietSince, null);
  assert.ok(!back.alertas.includes("bloque activo y ningun estudiante con eventos en 5 min"));
  assert.match(formatPilotMonitorLine(first.resumen, now), /\| bloque 1 \| worker CAIDO \| servidores 2 \(Google Cloud - V100 x1, Mac del laboratorio - M2 x1\) \| activos 5 min 0 \(con tutor 0, sin tutor 0\) \| p50 10 min 9,5 s \| sin fallo 90 % \| perdidos 3,2 % \| eventos 12$/);
});

test("monitor del piloto: sin respuesta del worker ni datos, la linea muestra guiones y el relay apagado alerta", () => {
  const now = new Date("2026-10-08T14:00:30.000Z");
  const input = healthyInput();
  input.health = { status: 0, data: { error: "fetch failed" } };
  input.backendHealth.data.workspace_agent_online = false;
  input.inference.data.listening = [{ id: "gce-l4", label: "Google Cloud - L4", alive: true, model: "qwen2.5-coder:14b" }];
  input.inference.data.worker = null;
  input.session.data = { ok: false, error: "Sesion requerida." };
  input.window10.data = { ok: false, error: "Sesion requerida." };
  input.window5.data = { ok: false, error: "Sesion requerida." };
  const { resumen, alertas } = evaluatePilotMonitor(input, { now });
  assert.deepEqual(alertas, [
    "sin worker (agent/health sin respuesta): el tutor responde degradado",
    "la VM de editores no esta conectada al relay: los estudiantes veran «El editor esta apagado» hasta que se encienda (bash deploy/clase.sh iniciar)",
  ]);
  assert.equal(resumen.modelo.aceptaImagenes, true, "un worker sin kinds es anterior a QUEUE_WORKER_KINDS y atiende imagenes");
  assert.equal(resumen.modelo.ultimoAtendio, null);
  assert.deepEqual(resumen.estudiantes, { activos5min: 0, porCondicion: {}, eventosSesion: 0, sinUsuario: 0, ultimoEvento: null });
  assert.deepEqual(formatPilotMonitorFields(resumen), [
    "bloque 0",
    "worker CAIDO",
    "servidores 1 (Google Cloud - L4 x1)",
    "activos 5 min 0 (con tutor 0, sin tutor 0)",
    "p50 10 min —",
    "sin fallo —",
    "perdidos —",
    "eventos 0",
  ]);
  const windows = monitorWindows(now, "2026-10-08T13:00:00.000Z");
  assert.deepEqual(windows, { session: "2026-10-08T13:00:00.000Z", recent: "2026-10-08T13:50:30.000Z", lastFive: "2026-10-08T13:55:30.000Z" });
});
