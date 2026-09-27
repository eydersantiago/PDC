import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { filterSourcesForLot, resolveEffectiveLot, summarizeLotsForCourse, type RagLot } from "../../src/services/rag-lots.js";
import type { RagSource } from "../../src/types/app.js";

async function startTestServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No se pudo iniciar servidor de prueba.");
  }
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json() as { session?: { id?: string; user?: { id?: string } }; error?: string };
  assert.equal(response.status, 200, data.error);
  assert.ok(data.session?.id);
  return data.session;
}

function jsonHeaders(sessionId: string) {
  return { "Content-Type": "application/json; charset=utf-8", "x-session-id": sessionId };
}

function buildUploadForm(title: string, lotId?: string) {
  const form = new FormData();
  form.set("title", title);
  form.set("courseCode", "FPOO");
  if (lotId) form.set("lotId", lotId);
  form.set(
    "file",
    new Blob([`${title}. Material de apoyo con enfoque distinto sobre clases, objetos y responsabilidades.`], { type: "text/plain" }),
    `${title.toLowerCase().replace(/\s+/g, "-")}.txt`,
  );
  return form;
}

function fakeSource(id: string, metadata: Record<string, unknown>, scope: "default" | "teacher" = "teacher"): RagSource {
  return {
    id,
    scope,
    teacherUserId: scope === "teacher" ? "t1" : null,
    sourceKey: id,
    title: id,
    sourceType: "document",
    fileName: `${id}.txt`,
    mimeType: "text/plain",
    contentSha256: id,
    contentText: "texto",
    metadata: { courseCode: "FPOO", ...metadata },
    isActive: true,
    createdByUserId: "t1",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    chunks: [],
  } as unknown as RagSource;
}

test("rag-lots: lote efectivo y filtrado de fuentes (funciones puras)", () => {
  const lots: RagLot[] = [
    { id: "l1", teacherUserId: "t1", courseCode: "FPOO", name: "Enfoque juegos", description: "", includesBase: true, isActive: true, createdAt: "", updatedAt: "" },
    { id: "l2", teacherUserId: "t1", courseCode: "FPOO", name: "Solo lote", description: "", includesBase: false, isActive: true, createdAt: "", updatedAt: "" },
    { id: "l3", teacherUserId: "t1", courseCode: "FPOE", name: "Otro curso", description: "", includesBase: true, isActive: true, createdAt: "", updatedAt: "" },
    { id: "l4", teacherUserId: "t1", courseCode: "FPOO", name: "Retirado", description: "", includesBase: true, isActive: false, createdAt: "", updatedAt: "" },
  ];
  // Sin nada configurado: base.
  assert.deepEqual(resolveEffectiveLot({ courseCode: "FPOO", lots, activeLotId: null }).origin, "base");
  // Lote activo del docente.
  assert.equal(resolveEffectiveLot({ courseCode: "FPOO", lots, activeLotId: "l1" }).lotId, "l1");
  // La asignacion del estudiante gana.
  const student = resolveEffectiveLot({ courseCode: "FPOO", lots, activeLotId: "l1", studentLotId: "l2" });
  assert.equal(student.lotId, "l2");
  assert.equal(student.origin, "student");
  assert.equal(student.includesBase, false);
  // Un lote retirado o de otro curso no aplica.
  assert.equal(resolveEffectiveLot({ courseCode: "FPOO", lots, activeLotId: "l4" }).origin, "base");
  assert.equal(resolveEffectiveLot({ courseCode: "FPOO", lots, activeLotId: "l3" }).origin, "base");

  const sources = [
    fakeSource("base-default", {}, "default"),
    fakeSource("base-teacher", {}),
    fakeSource("lote1-a", { lotId: "l1" }),
    fakeSource("lote2-a", { lotId: "l2" }),
  ];
  const overrides = [{ sourceId: "base-teacher", isActive: false }];
  const ids = (list: RagSource[]) => list.map((item) => item.id).sort();
  // Base: solo fuentes sin lote, sin las desactivadas.
  assert.deepEqual(ids(filterSourcesForLot(sources, resolveEffectiveLot({ courseCode: "FPOO", lots, activeLotId: null }), overrides)), ["base-default"]);
  // Lote con base: sus fuentes + la base activa.
  assert.deepEqual(ids(filterSourcesForLot(sources, resolveEffectiveLot({ courseCode: "FPOO", lots, activeLotId: "l1" }), overrides)), ["base-default", "lote1-a"]);
  // Lote sin base: solo sus fuentes.
  assert.deepEqual(ids(filterSourcesForLot(sources, resolveEffectiveLot({ courseCode: "FPOO", lots, activeLotId: "l2" }), overrides)), ["lote2-a"]);

  const summary = summarizeLotsForCourse({ courseCode: "FPOO", lots, sources, overrides, activeLotId: "l1" });
  assert.equal(summary.activeLotName, "Enfoque juegos");
  assert.deepEqual(summary.base, { sourceCount: 2, activeSourceCount: 1, defaultCount: 1, teacherCount: 1 });
  assert.deepEqual(summary.lots.map((lot) => [lot.id, lot.sourceCount, lot.isCourseActive]), [["l1", 1, true], ["l2", 1, false]]);
});

test("rag-lots: el docente crea lotes, activa uno por curso, desactiva fuentes base y asigna lotes por estudiante", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const student = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const teacherId = String(teacher.id);
    const studentId = String(student.id);
    const studentUserId = String(student.user?.id);

    // Solo docentes.
    const studentCatalog = await fetch(`${baseUrl}/api/rag/lots`, { headers: { "x-session-id": studentId } });
    assert.equal(studentCatalog.status, 403);
    assert.equal((await fetch(`${baseUrl}/api/rag/lots`)).status, 401);

    // Catalogo inicial: 4 cursos, base activa, sin lotes.
    const initialResponse = await fetch(`${baseUrl}/api/rag/lots`, { headers: { "x-session-id": teacherId } });
    const initial = await initialResponse.json() as {
      baseLotName?: string;
      courses?: Array<{ courseCode: string; activeLotId: string; activeLotName: string; base: { defaultCount: number }; lots: unknown[] }>;
      disabledSourceIds?: string[];
      error?: string;
    };
    assert.equal(initialResponse.status, 200, initial.error);
    assert.equal(initial.baseLotName, "Base del curso");
    assert.deepEqual(initial.courses?.map((course) => course.courseCode), ["FPI", "FPOO", "FPOE", "FPFC"]);
    const initialFpoo = initial.courses?.find((course) => course.courseCode === "FPOO");
    assert.equal(initialFpoo?.activeLotId, "");
    assert.equal(initialFpoo?.activeLotName, "Base del curso");
    assert.ok((initialFpoo?.base.defaultCount || 0) >= 1);
    assert.deepEqual(initialFpoo?.lots, []);
    assert.deepEqual(initial.disabledSourceIds, []);

    // Nombre corto: 400.
    const badCreate = await fetch(`${baseUrl}/api/rag/lots`, {
      method: "POST",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ courseCode: "FPOO", name: "x" }),
    });
    assert.equal(badCreate.status, 400);

    // Crear dos lotes en FPOO.
    const createResponse = await fetch(`${baseUrl}/api/rag/lots`, {
      method: "POST",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ courseCode: "FPOO", name: "Enfoque videojuegos", description: "Ejemplos con juegos", includesBase: true }),
    });
    const created = await createResponse.json() as { lot?: RagLot; error?: string };
    assert.equal(createResponse.status, 201, created.error);
    assert.ok(created.lot?.id);
    const lotA = created.lot;
    const createB = await fetch(`${baseUrl}/api/rag/lots`, {
      method: "POST",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ courseCode: "FPOO", name: "Solo mis apuntes", includesBase: false }),
    });
    const lotB = ((await createB.json()) as { lot?: RagLot }).lot;
    assert.ok(lotB?.id);
    assert.equal(lotB.includesBase, false);

    // Editar el lote.
    const editResponse = await fetch(`${baseUrl}/api/rag/lots/${encodeURIComponent(lotA.id)}`, {
      method: "PUT",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ description: "Ejemplos con videojuegos 2D" }),
    });
    const edited = await editResponse.json() as { lot?: RagLot; error?: string };
    assert.equal(editResponse.status, 200, edited.error);
    assert.equal(edited.lot?.name, "Enfoque videojuegos");
    assert.equal(edited.lot?.description, "Ejemplos con videojuegos 2D");

    // Cargar una fuente dentro del lote A y otra en la base.
    const lotUpload = await fetch(`${baseUrl}/api/rag/sources`, {
      method: "POST",
      headers: { "x-session-id": teacherId },
      body: buildUploadForm("Guia de sprites", lotA.id),
    });
    const lotUploaded = await lotUpload.json() as { source?: { id?: string; lotId?: string; metadata?: { lotId?: string } }; error?: string };
    assert.equal(lotUpload.status, 200, lotUploaded.error);
    assert.equal(lotUploaded.source?.lotId, lotA.id);
    assert.equal(lotUploaded.source?.metadata?.lotId, lotA.id);
    const baseUpload = await fetch(`${baseUrl}/api/rag/sources`, {
      method: "POST",
      headers: { "x-session-id": teacherId },
      body: buildUploadForm("Guia general de clases"),
    });
    const baseUploaded = await baseUpload.json() as { source?: { id?: string; lotId?: string }; error?: string };
    assert.equal(baseUpload.status, 200, baseUploaded.error);
    assert.equal(baseUploaded.source?.lotId, "");
    const baseSourceId = String(baseUploaded.source?.id);

    // Un lote de otro curso no sirve para cargar en FPOO.
    const otherCourseLot = await fetch(`${baseUrl}/api/rag/lots`, {
      method: "POST",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ courseCode: "FPOE", name: "Eventos con juegos" }),
    });
    const otherLot = ((await otherCourseLot.json()) as { lot?: RagLot }).lot;
    assert.ok(otherLot?.id);
    const wrongLotUpload = await fetch(`${baseUrl}/api/rag/sources`, {
      method: "POST",
      headers: { "x-session-id": teacherId },
      body: buildUploadForm("Fuente mal ubicada", otherLot.id),
    });
    assert.equal(wrongLotUpload.status, 400);

    // El estudiante, con la base activa, no ve la fuente del lote.
    const studentBase = await fetch(`${baseUrl}/api/rag/sources`, { headers: { "x-session-id": studentId } });
    const studentBaseList = await studentBase.json() as { sources?: Array<{ title: string }> };
    assert.ok(studentBaseList.sources?.some((source) => source.title === "Guia general de clases"));
    assert.ok(!studentBaseList.sources?.some((source) => source.title === "Guia de sprites"));

    // El docente ve todo el catalogo (todos los lotes) con isEnabled.
    const teacherAll = await fetch(`${baseUrl}/api/rag/sources`, { headers: { "x-session-id": teacherId } });
    const teacherAllList = await teacherAll.json() as { sources?: Array<{ id: string; title: string; lotId?: string; isEnabled?: boolean }> };
    assert.ok(teacherAllList.sources?.some((source) => source.title === "Guia de sprites" && source.lotId === lotA.id));
    assert.ok(teacherAllList.sources?.every((source) => source.isEnabled === true));

    // Activar el lote A en FPOO: el estudiante ve lote + base.
    const activate = await fetch(`${baseUrl}/api/rag/courses/FPOO/active-lot`, {
      method: "PUT",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ lotId: lotA.id }),
    });
    const activated = await activate.json() as { activeLotId?: string; catalog?: { courses: Array<{ courseCode: string; activeLotName: string }> }; error?: string };
    assert.equal(activate.status, 200, activated.error);
    assert.equal(activated.activeLotId, lotA.id);
    assert.equal(activated.catalog?.courses.find((course) => course.courseCode === "FPOO")?.activeLotName, "Enfoque videojuegos");
    const studentLotA = await fetch(`${baseUrl}/api/rag/sources`, { headers: { "x-session-id": studentId } });
    const studentLotAList = await studentLotA.json() as { sources?: Array<{ title: string }> };
    assert.ok(studentLotAList.sources?.some((source) => source.title === "Guia de sprites"));
    assert.ok(studentLotAList.sources?.some((source) => source.title === "Guia general de clases"));

    // Un lote de otro curso no puede activarse en FPOO.
    const wrongActivate = await fetch(`${baseUrl}/api/rag/courses/FPOO/active-lot`, {
      method: "PUT",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ lotId: otherLot.id }),
    });
    assert.equal(wrongActivate.status, 400);

    // Desactivar una fuente de la base: desaparece para el estudiante, el docente la sigue viendo apagada.
    const disable = await fetch(`${baseUrl}/api/rag/sources/${encodeURIComponent(baseSourceId)}/active`, {
      method: "PUT",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ isActive: false }),
    });
    assert.equal(disable.status, 200);
    const studentAfterDisable = await fetch(`${baseUrl}/api/rag/sources`, { headers: { "x-session-id": studentId } });
    const studentAfterDisableList = await studentAfterDisable.json() as { sources?: Array<{ title: string }> };
    assert.ok(!studentAfterDisableList.sources?.some((source) => source.title === "Guia general de clases"));
    assert.ok(studentAfterDisableList.sources?.some((source) => source.title === "Guia de sprites"));
    const teacherAfterDisable = await fetch(`${baseUrl}/api/rag/sources`, { headers: { "x-session-id": teacherId } });
    const teacherAfterDisableList = await teacherAfterDisable.json() as { sources?: Array<{ id: string; isEnabled?: boolean }> };
    assert.equal(teacherAfterDisableList.sources?.find((source) => source.id === baseSourceId)?.isEnabled, false);
    const catalogAfterDisable = await (await fetch(`${baseUrl}/api/rag/lots?courseCode=FPOO`, { headers: { "x-session-id": teacherId } })).json() as {
      courses?: Array<{ courseCode: string; base: { sourceCount: number; activeSourceCount: number } }>;
      disabledSourceIds?: string[];
    };
    assert.deepEqual(catalogAfterDisable.courses?.map((course) => course.courseCode), ["FPOO"]);
    assert.deepEqual(catalogAfterDisable.disabledSourceIds, [baseSourceId]);
    assert.equal(catalogAfterDisable.courses?.[0].base.sourceCount - catalogAfterDisable.courses?.[0].base.activeSourceCount, 1);
    // Y el motor de recuperacion tampoco la entrega.
    const chunks = await database.listRagChunksForUser(student.user as never, 500, { courseCode: "FPOO" });
    assert.ok(!chunks.some((chunk) => /Guia general de clases/.test(String(chunk.sourceTitle || ""))));
    assert.ok(chunks.some((chunk) => /Guia de sprites/.test(String(chunk.sourceTitle || ""))));
    // Volver a activarla.
    const enable = await fetch(`${baseUrl}/api/rag/sources/${encodeURIComponent(baseSourceId)}/active`, {
      method: "PUT",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ isActive: true }),
    });
    assert.equal(enable.status, 200);

    // Asignar el lote B (sin base) al estudiante: solo ve las fuentes de B (ninguna todavia).
    const assign = await fetch(`${baseUrl}/api/rag/students/${encodeURIComponent(studentUserId)}/lot`, {
      method: "PUT",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ courseCode: "FPOO", lotId: lotB.id }),
    });
    const assigned = await assign.json() as { lotId?: string; applied?: { lotId: string; lotName: string; origin: string }; error?: string };
    assert.equal(assign.status, 200, assigned.error);
    assert.equal(assigned.lotId, lotB.id);
    assert.deepEqual(assigned.applied, { lotId: lotB.id, lotName: "Solo mis apuntes", origin: "student" });
    const studentLotB = await fetch(`${baseUrl}/api/rag/sources`, { headers: { "x-session-id": studentId } });
    const studentLotBList = await studentLotB.json() as { sources?: Array<{ title: string }> };
    assert.deepEqual(studentLotBList.sources, []);
    // «RAG aplicado» en la lista de usuarios.
    const users = await (await fetch(`${baseUrl}/api/admin/users`, { headers: { "x-session-id": teacherId } })).json() as {
      users?: Array<{ id: string; role: string; ragLots?: Record<string, { lotId: string; lotName: string; origin: string }> }>;
    };
    const managedStudent = users.users?.find((user) => user.id === studentUserId);
    assert.deepEqual(managedStudent?.ragLots, { FPOO: { lotId: lotB.id, lotName: "Solo mis apuntes", origin: "student" } });
    // El docente solo lista a sus estudiantes; todos traen el lote aplicado por curso.
    assert.ok(users.users?.every((user) => user.role === "student" && user.ragLots && Object.keys(user.ragLots).length >= 1));
    // El tutor reporta el lote aplicado.
    const effective = await database.resolveRagLotForUser(student.user as never, "FPOO");
    assert.deepEqual(effective, { lotId: lotB.id, name: "Solo mis apuntes", includesBase: false, origin: "student" });

    // Quitar la asignacion: vuelve al lote activo del curso (A).
    const unassign = await fetch(`${baseUrl}/api/rag/students/${encodeURIComponent(studentUserId)}/lot`, {
      method: "PUT",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ courseCode: "FPOO", lotId: null }),
    });
    const unassigned = await unassign.json() as { lotId?: string | null; applied?: { lotId: string; origin: string } };
    assert.equal(unassign.status, 200);
    assert.equal(unassigned.lotId, null);
    assert.deepEqual(unassigned.applied, { lotId: lotA.id, lotName: "Enfoque videojuegos", origin: "teacher" });

    // Un estudiante de otro docente: 400.
    const foreign = await fetch(`${baseUrl}/api/rag/students/no-existe/lot`, {
      method: "PUT",
      headers: jsonHeaders(teacherId),
      body: JSON.stringify({ courseCode: "FPOO", lotId: lotA.id }),
    });
    assert.equal(foreign.status, 400);

    // Retirar el lote A: el curso vuelve a la base y el estudiante deja de ver la fuente del lote.
    const retire = await fetch(`${baseUrl}/api/rag/lots/${encodeURIComponent(lotA.id)}`, {
      method: "DELETE",
      headers: { "x-session-id": teacherId },
    });
    const retired = await retire.json() as { removed?: boolean; catalog?: { courses: Array<{ courseCode: string; activeLotId: string; lots: Array<{ id: string }> }> } };
    assert.equal(retire.status, 200);
    assert.equal(retired.removed, true);
    const fpooAfter = retired.catalog?.courses.find((course) => course.courseCode === "FPOO");
    assert.equal(fpooAfter?.activeLotId, "");
    assert.deepEqual(fpooAfter?.lots.map((lot) => lot.id), [lotB.id]);
    const studentAfterRetire = await fetch(`${baseUrl}/api/rag/sources`, { headers: { "x-session-id": studentId } });
    const studentAfterRetireList = await studentAfterRetire.json() as { sources?: Array<{ title: string }> };
    assert.ok(!studentAfterRetireList.sources?.some((source) => source.title === "Guia de sprites"));
    assert.ok(studentAfterRetireList.sources?.some((source) => source.title === "Guia general de clases"));
    assert.equal((await fetch(`${baseUrl}/api/rag/lots/${encodeURIComponent(lotA.id)}`, { method: "DELETE", headers: { "x-session-id": teacherId } })).status, 404);
  } finally {
    await stopTestServer(server, database);
  }
});
