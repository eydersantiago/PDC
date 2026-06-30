import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";

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

  return {
    database,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
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

function buildRagUploadForm() {
  const form = new FormData();
  form.set("title", "Guia docente de encapsulamiento");
  form.set("description", "Fuente cargada por docente para orientar recomendaciones.");
  form.set("tags", "poo,encapsulamiento,c++");
  form.set(
    "file",
    new Blob([
      "Encapsulamiento en C++: identifica atributos privados, metodos publicos y responsabilidades de cada clase.",
    ], { type: "text/plain" }),
    "guia-encapsulamiento.txt",
  );
  return form;
}

test("rag routes restringen carga a docentes y exponen fuentes default", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const unauthorized = await fetch(`${baseUrl}/api/rag/sources`);
    assert.equal(unauthorized.status, 401);

    const studentSession = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const studentUpload = await fetch(`${baseUrl}/api/rag/sources`, {
      method: "POST",
      headers: { "x-session-id": String(studentSession.id) },
      body: buildRagUploadForm(),
    });
    assert.equal(studentUpload.status, 403);

    const teacherSession = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const coursesResponse = await fetch(`${baseUrl}/api/rag/courses`, {
      headers: { "x-session-id": String(teacherSession.id) },
    });
    const courses = await coursesResponse.json() as {
      defaultCourseCode?: string;
      courses?: Array<{ code: string; isDefault?: boolean; materialUrl?: string }>;
    };
    assert.equal(coursesResponse.status, 200);
    assert.equal(courses.defaultCourseCode, "FPOO");
    assert.ok(courses.courses?.some((course) => course.code === "FPOO" && course.isDefault));
    assert.ok(courses.courses?.some((course) => course.code === "FPOE" && /1uoIyX8w6YzpK0BuBuX_E6ZyrUY4vknDh/.test(course.materialUrl || "")));

    const teacherUpload = await fetch(`${baseUrl}/api/rag/sources`, {
      method: "POST",
      headers: { "x-session-id": String(teacherSession.id) },
      body: buildRagUploadForm(),
    });
    const uploaded = await teacherUpload.json() as {
      source?: { id?: string; scope?: string; title?: string; textLength?: number };
      error?: string;
    };
    assert.equal(teacherUpload.status, 200, uploaded.error);
    assert.equal(uploaded.source?.scope, "teacher");
    assert.equal(uploaded.source?.title, "Guia docente de encapsulamiento");
    assert.ok((uploaded.source?.textLength || 0) > 40);

    const eventsForm = buildRagUploadForm();
    eventsForm.set("title", "Guia docente de eventos");
    eventsForm.set("courseCode", "FPOE");
    const eventsUpload = await fetch(`${baseUrl}/api/rag/sources`, {
      method: "POST",
      headers: { "x-session-id": String(teacherSession.id) },
      body: eventsForm,
    });
    const eventsUploaded = await eventsUpload.json() as {
      source?: { courseCode?: string; title?: string };
      error?: string;
    };
    assert.equal(eventsUpload.status, 200, eventsUploaded.error);
    assert.equal(eventsUploaded.source?.courseCode, "FPOE");

    const teacherUsersResponse = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { "x-session-id": String(teacherSession.id) },
    });
    const teacherUsers = await teacherUsersResponse.json() as {
      users?: Array<{
        id: string;
        role: string;
        email: string;
        assignedCourseCodes?: string[];
      }>;
      error?: string;
    };
    assert.equal(teacherUsersResponse.status, 200, teacherUsers.error);
    const managedStudent = teacherUsers.users?.find((user) => user.role === "student" && user.email === "estudiante@adaceen.edu.co");
    assert.ok(managedStudent?.id);
    assert.deepEqual(managedStudent.assignedCourseCodes, ["FPOO"]);

    const assignCoursesResponse = await fetch(`${baseUrl}/api/admin/users/${encodeURIComponent(managedStudent.id)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "x-session-id": String(teacherSession.id),
      },
      body: JSON.stringify({ assignedCourseCodes: ["FPOO", "FPOE"] }),
    });
    const assignedCourses = await assignCoursesResponse.json() as {
      user?: { assignedCourseCodes?: string[] };
      error?: string;
    };
    assert.equal(assignCoursesResponse.status, 200, assignedCourses.error);
    assert.deepEqual(assignedCourses.user?.assignedCourseCodes, ["FPOO", "FPOE"]);

    const studentCoursesResponse = await fetch(`${baseUrl}/api/rag/courses`, {
      headers: { "x-session-id": String(studentSession.id) },
    });
    const studentCourses = await studentCoursesResponse.json() as {
      courses?: Array<{ code: string }>;
      assignedCourseCodes?: string[];
    };
    assert.equal(studentCoursesResponse.status, 200);
    assert.deepEqual(studentCourses.assignedCourseCodes, ["FPOO", "FPOE"]);
    assert.deepEqual(studentCourses.courses?.map((course) => course.code), ["FPOO", "FPOE"]);

    const teacherListResponse = await fetch(`${baseUrl}/api/rag/sources`, {
      headers: { "x-session-id": String(teacherSession.id) },
    });
    const teacherList = await teacherListResponse.json() as {
      sources?: Array<{ scope: string; title: string; courseCode?: string }>;
    };
    assert.equal(teacherListResponse.status, 200);
    assert.ok(teacherList.sources?.some((source) => source.scope === "default" && /FPOO/.test(source.title)));
    assert.ok(teacherList.sources?.some((source) => source.scope === "teacher" && source.title === "Guia docente de encapsulamiento"));
    assert.ok(!teacherList.sources?.some((source) => source.title === "Guia docente de eventos"));

    const eventsListResponse = await fetch(`${baseUrl}/api/rag/sources?courseCode=FPOE`, {
      headers: { "x-session-id": String(teacherSession.id) },
    });
    const eventsList = await eventsListResponse.json() as {
      sources?: Array<{ scope: string; title: string; courseCode?: string }>;
    };
    assert.equal(eventsListResponse.status, 200);
    assert.ok(eventsList.sources?.some((source) => source.scope === "teacher" && source.title === "Guia docente de eventos" && source.courseCode === "FPOE"));
    assert.ok(!eventsList.sources?.some((source) => /FPOO/.test(source.title)));

    const imperativaListResponse = await fetch(`${baseUrl}/api/rag/sources?courseCode=FPI`, {
      headers: { "x-session-id": String(teacherSession.id) },
    });
    const imperativaList = await imperativaListResponse.json() as {
      sources?: Array<{ scope: string; title: string; courseCode?: string }>;
    };
    assert.equal(imperativaListResponse.status, 200);
    assert.ok(imperativaList.sources?.some((source) => (
      source.scope === "default"
      && source.title === "Programa del curso FPI - Fundamentos de Programación Imperativa"
      && source.courseCode === "FPI"
    )));
    assert.ok(imperativaList.sources?.some((source) => (
      source.title === "Bibliografía FPI - How to Think Like a Computer Scientist: Learning with Python"
      && source.courseCode === "FPI"
    )));
    assert.ok(imperativaList.sources?.every((source) => source.courseCode === "FPI"));

    const allCoursesResponse = await fetch(`${baseUrl}/api/rag/sources?allCourses=true`, {
      headers: { "x-session-id": String(teacherSession.id) },
    });
    const allCoursesList = await allCoursesResponse.json() as {
      sources?: Array<{ title: string }>;
    };
    assert.equal(allCoursesResponse.status, 200);
    assert.ok(allCoursesList.sources?.some((source) => source.title === "Guia docente de eventos"));

    const studentListResponse = await fetch(`${baseUrl}/api/rag/sources`, {
      headers: { "x-session-id": String(studentSession.id) },
    });
    const studentList = await studentListResponse.json() as {
      courseCode?: string;
      sources?: Array<{ id?: string; scope: string; title: string }>;
    };
    assert.equal(studentListResponse.status, 200);
    assert.equal(studentList.courseCode, "FPOO");
    assert.ok(studentList.sources?.some((source) => source.scope === "teacher" && source.title === "Guia docente de encapsulamiento"));

    const viewerSource = studentList.sources?.find((source) => source.scope === "teacher" && source.title === "Guia docente de encapsulamiento");
    assert.ok(viewerSource?.id);
    const viewerResponse = await fetch(`${baseUrl}/api/rag/sources/${encodeURIComponent(viewerSource.id)}/view?courseCode=FPOO`);
    const viewerHtml = await viewerResponse.text();
    assert.equal(viewerResponse.status, 200);
    assert.match(viewerResponse.headers.get("content-type") || "", /text\/html/);
    assert.match(viewerHtml, /Fuente RAG consultada/);
    assert.match(viewerHtml, /Guia docente de encapsulamiento/);
    assert.match(viewerHtml, /Encapsulamiento en C\+\+/);

    const viewerWrongCourse = await fetch(`${baseUrl}/api/rag/sources/${encodeURIComponent(viewerSource.id)}/view?courseCode=FPOE`);
    assert.equal(viewerWrongCourse.status, 404);

    const studentEventsListResponse = await fetch(`${baseUrl}/api/rag/sources?courseCode=FPOE`, {
      headers: { "x-session-id": String(studentSession.id) },
    });
    const studentEventsList = await studentEventsListResponse.json() as {
      courseCode?: string;
      sources?: Array<{ scope: string; title: string; courseCode?: string }>;
    };
    assert.equal(studentEventsListResponse.status, 200);
    assert.equal(studentEventsList.courseCode, "FPOE");
    assert.ok(studentEventsList.sources?.some((source) => source.title === "Guia docente de eventos" && source.courseCode === "FPOE"));

    const studentBlockedCourseResponse = await fetch(`${baseUrl}/api/rag/sources?courseCode=FPFC`, {
      headers: { "x-session-id": String(studentSession.id) },
    });
    const studentBlockedCourse = await studentBlockedCourseResponse.json() as {
      courseCode?: string;
      sources?: Array<{ courseCode?: string }>;
    };
    assert.equal(studentBlockedCourseResponse.status, 200);
    assert.equal(studentBlockedCourse.courseCode, "FPOO");
    assert.ok(studentBlockedCourse.sources?.every((source) => source.courseCode === "FPOO"));
  } finally {
    await stopTestServer(server, database);
  }
});
