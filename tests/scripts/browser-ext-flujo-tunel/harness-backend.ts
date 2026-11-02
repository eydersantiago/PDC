import { shiftBitacoraAgendaToStart } from "../../../src/services/bitacora/bitacora-dates.js";
import { BACKEND, REPO, STAFF_VM_COMMAND, CODESPACE_URL, CAMPUS_COURSE_URL, SESSION, type Json } from "./harness-config.js";
import { FakeBrowserState } from "./harness-browser.js";

// El navegador falso completo: su estado (harness-browser.ts) y el backend falso (fetch).
export class FakeBrowser extends FakeBrowserState {
  async fetch(input: unknown, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const url = new URL(String(input));
    const method = String(init.method || "GET").toUpperCase();
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : null;
    this.requests.push({ method, path: url.pathname, query: url.search, body, headers: { ...(init.headers || {}) }, at: this.clock.now });
    const delay = this.delays[url.pathname];
    if (delay) {
      // Como fetch: el AbortController de fetchJsonWithTimeout corta la espera.
      await new Promise((resolve, reject) => {
        this.clock.setTimeout(resolve, delay);
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    const reply = (status: number, json: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => structuredClone(json),
    });
    if (url.origin !== BACKEND) return reply(404, { ok: false, error: "fuera del backend" });
    const authed = init.headers?.["x-session-id"] === SESSION.id && this.sessionValid;
    const route = `${method} ${url.pathname}`;

    switch (route) {
      case "GET /api/auth/me":
        return authed
          ? reply(200, { ok: true, session: this.session, policy: this.policy, telemetry: [], ...(this.privacy ? { privacy: this.privacy } : {}) })
          : reply(401, { ok: false, error: "Sesion no valida." });
      case "POST /api/auth/login":
      case "POST /api/auth/google-login":
        if (this.loginSteps.length) {
          const step = this.loginSteps.shift()!;
          return reply(step.status || 200, step.body);
        }
        this.sessionValid = true;
        return reply(200, {
          ok: true,
          session: this.session,
          policy: this.policy,
          telemetry: [],
          firstLogin: this.firstLogin,
          ...(this.privacy ? { privacy: this.privacy } : {}),
        });
      case "POST /api/auth/privacy-acceptance":
        if (!this.privacy) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.privacyAcceptances.push(body || {});
        this.privacy = { version: String(body?.version || ""), acceptedAt: new Date(this.clock.now).toISOString() };
        return reply(200, { ok: true, privacy: this.privacy });
      case "GET /api/rag/courses":
        return reply(200, {
          ok: true,
          courses: [
            { code: "FPI", name: "Fundamentos de programacion Imperativa", shortName: "Imperativa", materialUrl: "https://drive.google.com/x", isDefault: false },
            { code: "FPOO", name: "Fundamentos de programacion orientada a objetos", shortName: "FPOO", materialUrl: "https://drive.google.com/y", isDefault: true },
          ],
          assignedCourseCodes: ["FPOO"],
          defaultCourseCode: "FPOO",
        });
      case "POST /api/auth/logout":
        return reply(200, { ok: true });
      case "GET /api/ui/active-tab":
      case "POST /api/ui/active-tab":
        return reply(200, { ok: true, activeTab: this.activeTab });
      case "POST /api/behavior/events":
        return reply(200, { ok: true, accepted: 0 });
      case "GET /api/admin/clase/estado":
        if (!this.classStatus) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, { ok: true, ...this.classStatus });
      case "POST /api/admin/clase/iniciar": {
        if (!this.classStatus) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.classStarts += 1;
        // Como src/services/infra/class-start.ts: la VM de editores y la primera GPU quedan "starting".
        const editors = this.classStatus.editors as Json | null;
        const gpus = (this.classStatus.gpus as Json[]) || [];
        this.classStatus = {
          ...this.classStatus,
          editors: editors ? { ...editors, state: "starting", startRequestedAt: new Date(this.clock.now).toISOString() } : null,
          gpus: gpus.map((gpu, index) => (index === 0 ? { ...gpu, state: "starting", startRequestedAt: new Date(this.clock.now).toISOString() } : gpu)),
          gpu: gpus.length ? "starting" : "none",
          requestedBy: "Admin Prueba (admin, u-admin)",
          requestedAt: new Date(this.clock.now).toISOString(),
        };
        return reply(200, {
          ok: true,
          ...this.classStatus,
          actions: ["instances.start adaceen-ws", "instances.start adaceen-worker-v100"],
          message: "Encendiendo la VM de editores (el agente se conecta en 1-2 min). Encendiendo la GPU adaceen-worker-v100 (2-5 min; la primera vez hasta 12).",
        });
      }
      case "GET /api/admin/workspace-provider":
        if (!this.workspaceSetting) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, { ok: true, ...this.workspaceSetting });
      case "PUT /api/admin/workspace-provider": {
        if (!this.workspaceSetting) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.workspaceSettingPuts.push(body || {});
        const requested = String(body?.provider || "");
        // Como src/routes/workspace/workspace-routes.ts: el tunel sin el agente configurado es 409.
        if (requested === "tunnel" && !this.workspaceSetting.agentConfigured) {
          const message = "Para usar el editor en la nube falta conectar la VM de editores una vez: corre bash deploy/produccion.sh aplicar en Cloud Shell.";
          return reply(409, { ok: false, code: "agent_not_configured", error: message, message });
        }
        const choice = requested === "server" ? null : requested;
        const provider = choice || String(this.workspaceSetting.serverProvider);
        this.workspaceSetting = {
          ...this.workspaceSetting,
          provider,
          choice,
          source: choice ? "extension" : "server",
          updatedAt: new Date(this.clock.now).toISOString(),
          updatedBy: "Admin Prueba",
        };
        this.provider = provider;
        const target = provider === "tunnel" ? "editor en la nube (túnel de VS Code)" : "GitHub Codespaces";
        return reply(200, {
          ok: true,
          ...this.workspaceSetting,
          message: `Entorno de los estudiantes: ${target}. Lo verán al recargar la página o en unos minutos.`,
          ...(provider === "tunnel" && this.workspaceSetting.agentOnline === false && !this.workspaceSetting.vmAutostart
            ? { warning: "La VM de editores está apagada: enciéndela antes de la clase con bash deploy/clase.sh iniciar." }
            : {}),
        });
      }
      case "GET /api/workspaces/provider":
        return this.providerStatus === 200
          ? reply(200, { ok: true, provider: this.provider })
          : reply(this.providerStatus, { ok: false, error: `HTTP ${this.providerStatus}` });
      case "GET /api/github/oauth/status":
        return reply(200, {
          ok: true,
          configured: true,
          connected: this.githubConnected,
          accountLogin: this.githubConnected ? this.githubAccountLogin : "",
          updatedAt: this.githubConnected ? this.githubUpdatedAt : null,
          scopes: this.githubConnected ? ["read:user", ...(this.githubCodespaceScope ? ["codespace"] : [])] : [],
          hasCodespaceScope: this.githubConnected && this.githubCodespaceScope,
        });
      case "GET /api/github-app/status":
        // Sin la GitHub App instalada: el tunel no debe pedirla.
        return reply(200, { ok: true, status: { ...this.appStatus, repoFullName: url.searchParams.get("repoFullName") || "" } });
      case "POST /api/github/oauth/start":
        return reply(200, { ok: true, authorizeUrl: "https://github.com/login/oauth/authorize?client_id=prueba&state=estado" });
      case "POST /api/github/oauth/redirect-error":
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, { ok: true, recorded: true, callbackUrl: `${BACKEND}/auth/github/callback` });
      case "POST /api/workspaces/prepare": {
        const next = this.prepareSteps.shift() || this.lastWorkspace || this.ready();
        this.lastWorkspace = next;
        return reply(200, next);
      }
      case "GET /api/workspaces/status": {
        const next = this.statusSteps.shift() || this.lastWorkspace || this.notFound();
        this.lastWorkspace = next;
        return reply(200, next);
      }
      case "POST /api/auth/editor/pairing-code":
        this.pairingCodes += 1;
        if (this.pairingMode === "missing") return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (this.pairingMode === "fail") return reply(503, { ok: false, error: "Servicio no disponible." });
        return authed
          ? reply(200, { ok: true, code: "K7P4-M2QX", expiresAt: new Date(this.clock.now + 600_000).toISOString(), ttlSeconds: 600 })
          : reply(401, { ok: false, error: "Sesion no valida." });
      case "GET /api/projects/session/state":
        return reply(200, { ok: true, state: { latestRack: this.latestRack, latestRackForFile: null, ...(this.vscodeExtension ? { vscodeExtension: this.vscodeExtension } : {}) } });
      case "GET /api/vscode/presence":
        if (!this.vscodePresence) return reply(404, { ok: false, error: "Ruta no encontrada" });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, {
          ok: true,
          ...this.vscodePresence,
          ...(["teacher", "admin"].includes(String((this.session.user as Json).role)) ? { workspaceVmStartupCommand: STAFF_VM_COMMAND } : {}),
        });
      case "POST /intervene":
        if (this.interveneStatus !== 200) return reply(this.interveneStatus, { ok: false, error: `HTTP ${this.interveneStatus}` });
        return reply(200, { ok: true, ...this.tutorReply });
      case "POST /github-mentor":
        return reply(200, { ok: true, ...this.tutorReply });
      case "GET /api/admin/students":
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, {
          ok: true,
          generatedAt: new Date(this.clock.now).toISOString(),
          viewerRole: String((this.session as Json)?.user && ((this.session as Json).user as Json).role),
          totals: { students: this.students.length, activeNow: 1, withQuizzes: 1, averageGrade: 73, interventions: 3, blocked: 1 },
          students: this.students.filter((student) => !this.removedUserIds.includes(String(student.id))),
        });
      case "GET /api/documents/classifications":
        return reply(200, { ok: true, items: [] });
      // ---- Codespaces: GitHub App, PR y Codespace ----
      case "POST /api/github-app/install-url":
        return reply(200, { ok: true, installUrl: "https://github.com/apps/adaceen-piloto/installations/new?state=estado-app" });
      case "POST /api/github-app/link-installation-auto":
        if (!this.appAutoLink) {
          return reply(404, { ok: false, error: `No se encontro una instalacion con acceso a ${body?.repoFullName}.` });
        }
        this.appStatus = { ...this.appStatus, installation: { accountLogin: "univalle-fpoo" }, hasRepoAccess: true };
        return reply(200, { ok: true, linkedInstallation: { installationId: "99" } });
      case "POST /github/prepare-environment":
        // Como el backend: la preparacion queda registrada y /api/github-app/status la reporta.
        this.appStatus = {
          ...this.appStatus,
          bootstrapReady: true,
          bootstrapPullNumber: 7,
          bootstrapPullUrl: `https://github.com/${REPO}/pull/7`,
          bootstrapBranchName: "adaceen/devcontainer",
          bootstrapCodespaceUrl: CODESPACE_URL,
        };
        return reply(200, {
          ok: true,
          status: "ready",
          automation: "created",
          repository: REPO,
          pullRequest: { number: 7, url: `https://github.com/${REPO}/pull/7`, branchName: "adaceen/devcontainer" },
          codespace: { name: "fluffy-space-xyz", webUrl: CODESPACE_URL, state: "Available", ready: true },
          fallback: { webUrl: `https://codespaces.new/${REPO}` },
        });
      case "GET /api/github/codespaces/status":
        return reply(200, { ok: true, found: false, codespace: null });
      case "POST /api/rag/sources": {
        // Como src/routes/rag/rag-routes.ts: una fuente del docente por peticion (multipart).
        const form = init.body instanceof FormData ? init.body : null;
        const file = form?.get("file") as { name?: string } | null;
        const fileName = String(file?.name || form?.get("title") || "fuente");
        // Como rag-routes.ts (0.7.22): el administrador tiene que decir en el RAG de qué docente.
        const owner = this.sessionRole() === "admin" ? String(form?.get("teacherUserId") || "") : "u-docente";
        if (!owner) return reply(400, { ok: false, error: "Elige el docente dueño del RAG (teacherUserId)." });
        this.ragUploads.push({ fileName, courseCode: String(form?.get("courseCode") || ""), lotId: String(form?.get("lotId") || ""), owner });
        if (this.ragUploadFailures.includes(fileName)) return reply(422, { ok: false, error: "El archivo no tiene texto legible." });
        const source = { id: `RAG-T-${this.ragUploads.length + 10}`, courseCode: String(form?.get("courseCode") || "FPOO"), scope: "teacher", title: fileName, fileName, sourceType: "document", textLength: 1200, createdAt: new Date(this.clock.now).toISOString(), ownerId: owner };
        this.ragSources.push(source);
        return reply(200, { ok: true, teacherUserId: owner, source });
      }
      case "GET /api/rag/sources": {
        const listed = (sources: Json[]) => sources.map((source) => ({ ...source, lotId: source.lotId || "", isEnabled: !this.ragDisabledSourceIds.includes(String(source.id)) }));
        if (this.sessionRole() === "admin") {
          // Como rag-routes.ts: el docente pedido (o el primero), sus fuentes y las del programa.
          const requested = url.searchParams.get("teacherUserId") || "";
          const chosen = this.adminTeachers.find((teacher) => teacher.id === requested) || this.adminTeachers[0];
          const own = this.ragSources.filter((source) => source.scope !== "teacher" || (source.ownerId || "u-docente") === chosen?.id);
          return reply(200, { ok: true, courseCode: "FPOO", teacherUserId: chosen?.id || "", teachers: this.adminTeachers, sources: listed(own) });
        }
        return reply(200, { ok: true, courseCode: "FPOO", sources: listed(this.ragSources) });
      }
      case "GET /api/admin/users":
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, {
          ok: true,
          users: this.adminUsers.map((user) => (user.role === "student" ? { ...user, ragLots: this.appliedRagLots(user) } : { ...user, ragLots: {} })),
          teachers: this.adminTeachers,
          accessRequests: this.accessRequests,
          ...(this.defaultTeacher && this.sessionRole() === "admin" ? { defaultTeacher: this.defaultTeacher } : {}),
        });
      case "POST /api/admin/users/bulk-delete": {
        // Como removeManagedStudents: quien nunca entro se borra; quien ya entro se desactiva.
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.bulkDeletes.push(structuredClone(body || {}));
        const ids = ((body?.userIds as string[]) || []).map(String);
        const result = { deleted: [] as Json[], deactivated: [] as Json[], skipped: [] as Json[] };
        for (const id of ids) {
          const user = this.adminUsers.find((entry) => entry.id === id);
          if (!user || user.role !== "student") {
            result.skipped.push({ id, email: String(user?.email || ""), displayName: String(user?.displayName || ""), reason: user ? "No es estudiante: los docentes se eliminan uno a uno." : "No existe." });
            continue;
          }
          if (user.hasSignedIn) {
            user.isActive = false;
            result.deactivated.push({ id, email: user.email, displayName: user.displayName, reason: "Ya entró: se desactivó y conserva sus datos del piloto." });
            continue;
          }
          this.adminUsers = this.adminUsers.filter((entry) => entry.id !== id);
          this.removedUserIds.push(id);
          result.deleted.push({ id, email: user.email, displayName: user.displayName });
        }
        return reply(200, { ok: true, ...result });
      }
      case "POST /api/admin/users": {
        // Como src/routes/admin/admin-routes.ts: un docente queda en teachers.
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.createdUsers.push(structuredClone(body || {}));
        const user = { id: `u-nuevo-${this.createdUsers.length}`, role: String(body?.role || "student"), email: String(body?.email || "").toLowerCase(), displayName: String(body?.displayName || ""), teacherUserId: null, assignedCourseCodes: [], isActive: true, createdAt: new Date(this.clock.now).toISOString() };
        if (user.role === "teacher") this.adminTeachers.push({ id: user.id, email: user.email, displayName: user.displayName });
        this.adminUsers.push(user);
        return reply(200, { ok: true, user });
      }
      case "POST /api/admin/users/import": {
        // Como importCourseMembers (src/db/repos/users.ts): por correo, crea, actualiza o se salta.
        if (this.importStatus !== 200) return reply(this.importStatus, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.importRequests.push(structuredClone(body || {}));
        const role = this.sessionRole();
        const teacherUserId = role === "teacher" ? String((this.session.user as Json).id) : String(body?.teacherUserId || "u-docente");
        const teacher = this.adminTeachers.find((entry) => entry.id === teacherUserId);
        const courseCode = String(body?.courseCode || "FPOO");
        const result = { teacherUserId, courseCode, created: [] as Json[], updated: [] as Json[], unchanged: [] as Json[], skipped: [] as Json[] };
        for (const student of (body?.students as Json[]) || []) {
          const email = String(student.email || "").toLowerCase();
          const existing = this.adminUsers.find((user) => String(user.email).toLowerCase() === email);
          if (!existing) {
            const user = { id: `u-imp-${this.adminUsers.length + 1}`, role: "student", email, displayName: String(student.displayName || email), teacherUserId, teacherDisplayName: String(teacher?.displayName || ""), assignedCourseCodes: [courseCode], isActive: true, createdAt: new Date(this.clock.now).toISOString() };
            this.adminUsers.push(user);
            result.created.push({ id: user.id, email, displayName: user.displayName });
            continue;
          }
          if (existing.role !== "student") {
            result.skipped.push({ email, displayName: existing.displayName, reason: "Es docente en ADACEEN." });
            continue;
          }
          if (existing.isActive === false) {
            result.skipped.push({ email, displayName: existing.displayName, reason: "La cuenta esta desactivada: activala en la lista si debe entrar." });
            continue;
          }
          const codes = (existing.assignedCourseCodes as string[]) || [];
          const changes = [...(existing.teacherUserId !== teacherUserId ? ["docente"] : []), ...(codes.includes(courseCode) ? [] : ["curso"])];
          if (!changes.length) {
            result.unchanged.push({ id: existing.id, email, displayName: existing.displayName });
            continue;
          }
          existing.teacherUserId = teacherUserId;
          existing.teacherDisplayName = String(teacher?.displayName || "");
          existing.assignedCourseCodes = codes.includes(courseCode) ? codes : [...codes, courseCode];
          result.updated.push({ id: existing.id, email, displayName: existing.displayName, changes });
        }
        return reply(200, { ok: true, ...result });
      }
      case "PUT /api/admin/default-teacher": {
        if (!this.defaultTeacher) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.defaultTeacherPuts.push(structuredClone(body || {}));
        const chosen = body?.teacherUserId ? String(body.teacherUserId) : null;
        this.defaultTeacher = { teacherUserId: chosen || "u-docente", chosenTeacherUserId: chosen, source: chosen ? "admin" : "oldest", chosenInactive: false, updatedAt: new Date(this.clock.now).toISOString(), updatedByName: "Admin Prueba" };
        return reply(200, { ok: true, defaultTeacher: this.defaultTeacher });
      }
      // ---- Tema del piloto (0.7.21) ----
      case "GET /api/pilot/topic": {
        if (this.pilotTopicStatus !== 200) return reply(this.pilotTopicStatus, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        const role = this.sessionRole();
        if (role === "student") return reply(200, { ok: true, teacherUserId: "u-docente", topic: this.pilotTopic });
        return reply(200, {
          ok: true,
          teacherUserId: role === "admin" ? (url.searchParams.get("teacherUserId") || "u-docente") : String((this.session.user as Json).id),
          topic: this.pilotTopic,
          weeks: this.pilotTopicWeeks,
          ...(role === "admin" ? { teachers: this.adminTeachers } : {}),
        });
      }
      case "PUT /api/pilot/topic": {
        if (this.pilotTopicStatus !== 200) return reply(this.pilotTopicStatus, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.pilotTopicPuts.push(structuredClone(body || {}));
        const teacherUserId = this.sessionRole() === "admin" ? String(body?.teacherUserId || "") : String((this.session.user as Json).id);
        if (this.sessionRole() === "admin" && !teacherUserId) return reply(400, { ok: false, error: "Indica teacherUserId: el piloto va por docente." });
        if (body?.clear) {
          this.pilotTopic = null;
          return reply(200, { ok: true, teacherUserId, topic: null, message: "Tema del piloto quitado: los estudiantes ya no lo ven en Inicio." });
        }
        // Como normalizePilotTopicRepo (src/services/pilot/pilot-topic.ts), sin los casos raros.
        const rawRepo = String(body?.repoFullName || "").trim();
        const repo = rawRepo.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "").replace(/\.git$/i, "").split(/[?#]/)[0].split("/").slice(0, 2).join("/");
        if (rawRepo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          return reply(400, { ok: false, error: "El repositorio debe ser usuario/repositorio o su enlace de GitHub (https://github.com/usuario/repositorio)." });
        }
        const week = Number(body?.week) || 0;
        const title = String(body?.title || "").trim() || String((this.pilotTopicWeeks.find((entry) => entry.week === week) as Json | undefined)?.topic || "");
        if (!week && !title) return reply(400, { ok: false, error: "Elige una semana de la bitacora o escribe el tema." });
        this.pilotTopic = { courseCode: String(body?.courseCode || "FPOO"), week, title, repoFullName: rawRepo ? repo : "", updatedAt: new Date(this.clock.now).toISOString(), updatedByUserId: "u-docente", updatedByName: this.sessionRole() === "admin" ? "Admin Prueba" : "Docente Prueba" };
        const what = [week ? `semana ${week}` : "", title, rawRepo ? `ejercicio ${repo}` : ""].filter(Boolean).join(" · ");
        return reply(200, { ok: true, teacherUserId, topic: this.pilotTopic, message: `Tema del piloto guardado (${what}). Los estudiantes lo ven en Inicio y el tutor se enfoca en esa semana.` });
      }
      // ---- Campus ----
      case "POST /api/documents/bitacora/import": {
        // Como src/routes/document-routes: clasifica el archivo y, si es bitacora, queda como la ultima.
        const form = init.body instanceof FormData ? init.body : null;
        const fileName = String(form?.get("fileName") || "bitacora.xlsx");
        this.bitacoraUploads.push(fileName);
        // Como bitacora-owner.ts: el administrador tiene que decir de qué docente es.
        if (this.sessionRole() === "admin") {
          const owner = String(form?.get("teacherUserId") || "");
          if (!owner) return reply(400, { ok: false, error: "Elige el docente dueño de la bitácora (teacherUserId)." });
          this.bitacoraUploadOwners.push(owner);
          this.bitacoraLatestOwner = owner;
        }
        const agenda = {
          items: [
            { title: "Programa y reglas de juego", type: "activity", category: "Actividad", dueAt: "2026-08-10", visibleDueText: "10-08-2026", description: "Tema: Programa del curso | Actividades en clase: Programa y reglas de juego", evidence: ["Semana: 1", "Hoja: Bitacora"] },
            { title: "Quiz Pilares", type: "task", category: "Quiz", dueAt: "2026-08-17", visibleDueText: "17-08-2026", description: "Tema: Pilares de la POO | Actividades evaluación: Quiz Pilares", evidence: ["Semana: 2", "Hoja: Bitacora"] },
          ],
          summary: "",
          warnings: [],
        };
        const stored = { id: `bitacora-${this.bitacoraUploads.length + 1}`, fileName, filePath: fileName, label: "BITACORA", confidence: 0.97, method: "rules", evidence: [], bitacoraAgenda: agenda, classifiedAt: new Date(this.clock.now).toISOString(), updatedAt: new Date(this.clock.now).toISOString() };
        this.bitacoraLatest = stored;
        return reply(200, { ok: true, stored, classification: { label: "BITACORA", confidence: 0.97 }, import: { rowsUsed: agenda.items.length, bitacoraAgenda: agenda } });
      }
      case "PUT /api/documents/bitacora/start-date": {
        // Como src/routes/bitacora/bitacora-data-routes.ts (0.7.17): corre la bitacora del docente.
        const latest = this.bitacoraLatest as Json | null;
        if (!latest) return reply(404, { ok: false, error: "No hay bitacora cargada. Subela primero." });
        const shift = shiftBitacoraAgendaToStart(latest.bitacoraAgenda as Parameters<typeof shiftBitacoraAgendaToStart>[0], String(body?.startDate || ""));
        if (!shift) return reply(400, { ok: false, error: "Fecha de inicio invalida: usa aaaa-mm-dd." });
        this.bitacoraLatest = { ...latest, bitacoraAgenda: shift.agenda, updatedAt: new Date(this.clock.now).toISOString() };
        return reply(200, { ok: true, latest: this.bitacoraLatest, startDate: shift.startDate, previousStartDate: shift.previousStartDate, shiftDays: shift.shiftDays, firstDate: shift.firstDate, lastDate: shift.lastDate, weeks: shift.weeks });
      }
      case "GET /api/documents/bitacora/status": {
        if (this.bitacoraStatus !== 200) return reply(this.bitacoraStatus, { ok: false, error: "No se pudo leer la bitacora." });
        if (this.sessionRole() === "admin") {
          // Como bitacora-data-routes.ts: el docente pedido (o el primero) y la lista para elegir.
          const requested = url.searchParams.get("teacherUserId") || "";
          const chosen = this.adminTeachers.find((teacher) => teacher.id === requested) || this.adminTeachers[0];
          const latest = chosen && this.bitacoraLatestOwner === chosen.id ? this.bitacoraLatest : null;
          return reply(200, { ok: true, courseCode: "FPOO", latest, summary: { rows: latest ? 12 : 0 }, teacherUserId: chosen?.id || "", teachers: this.adminTeachers });
        }
        return reply(200, { ok: true, courseCode: "FPOO", latest: this.bitacoraLatest, summary: { rows: this.bitacoraLatest ? 12 : 0 } });
      }
      case "POST /api/campus/analyze-page":
        return reply(200, {
          ok: true,
          analysis: {
            course: { id: 77, title: "FPOO", url: CAMPUS_COURSE_URL },
            summary: "Curso con 1 tarea con fecha.",
            agenda: [{ title: "Taller 1: clases y objetos", type: "assign", url: `${CAMPUS_COURSE_URL}#taller-1`, dueAt: "2026-10-02T22:00:00.000Z" }],
            stats: { activityCount: 1, taskCount: 1, deadlineCount: 1 },
          },
        });
      // ---- Docente: politica, quiz de la clase y piloto ----
      case "GET /api/policies/current":
        return reply(200, { ok: true, policy: this.policy, telemetry: [] });
      case "PUT /api/policies/current":
        this.policy = { ...this.policy, ...(body || {}) };
        return reply(200, { ok: true, policy: this.policy, telemetry: [] });
      case "POST /api/quiz/launches": {
        const launch = { id: `quiz-${this.quizLaunches.length + 1}`, topic: String(body?.topic || ""), active: true, results: { answered: 0, correct: 0 } };
        this.quizLaunches.unshift(launch);
        return reply(200, { ok: true, launch, ...(this.quizLaunchReply || {}) });
      }
      case "GET /api/quiz/launches":
        return reply(200, { ok: true, launches: this.quizLaunches });
      // ---- Lotes de RAG (0.7.15) ----
      case "GET /api/rag/lots":
        return reply(200, { ok: true, ...this.ragLotCatalog() });
      case "POST /api/rag/lots": {
        const lot = {
          id: `lote-${this.ragLots.length + 1}`,
          courseCode: String(body?.courseCode || "FPOO"),
          name: String(body?.name || ""),
          description: String(body?.description || ""),
          includesBase: body?.includesBase !== false,
          isActive: true,
        };
        this.ragLots.push(lot);
        return reply(201, { ok: true, lot, catalog: this.ragLotCatalog() });
      }
      case "GET /api/quiz/custom":
        return reply(200, {
          ok: true,
          quizzes: this.customQuizzes.map((quiz) => ({
            ...quiz,
            launchCount: this.customQuizLaunches.filter((id) => id === quiz.id).length,
            lastLaunchedAt: this.customQuizLaunches.includes(String(quiz.id)) ? "2026-09-27T14:00:00.000Z" : null,
            activeLaunchId: this.customQuizLaunches.includes(String(quiz.id)) && !this.closedLaunches.includes(`launch-${quiz.id}`) ? `launch-${quiz.id}` : null,
            results: { total: 0, answered: 0, correct: 0, correctRate: null },
          })),
          launches: [],
        });
      case "GET /api/quiz/attempts":
        return reply(200, { ok: true, attempts: this.quizAttempts, summary: { total: this.quizAttempts.length, students: 1, answered: this.quizAttempts.length, correct: 1, correctRate: 50, followUps: 0, skipped: 0 } });
      default:
        return this.fetchByPattern(route, body, reply);
    }
  }

  requestsTo(pathname: string, method = "") {
    return this.requests.filter((request) => request.path === pathname && (!method || request.method === method));
  }
}
