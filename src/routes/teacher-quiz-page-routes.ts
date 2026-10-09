import { randomBytes } from "node:crypto";
import type express from "express";
import { RAG_COURSES } from "../services/rag-courses.js";
import { escapeHtml, setTeacherPageSecurityHeaders } from "./teacher-page-utils.js";

/**
 * Pagina del docente para crear y lanzar quices (navegador 0.7.15): GET /docente/quices.
 *
 * La abre el boton «Crear quiz» de la pestana «Quices» del overlay en otra pestana del
 * navegador. La sesion llega de dos formas: el content script de la extension
 * (browser-ext-prod/inicio/pagina-quices.content.js) la manda con postMessage
 * ("adaceen:session") y, si no llega en unos segundos, la pagina muestra el inicio de
 * sesion con correo y contrasena. Todo lo demas son las rutas de la API
 * (/api/quiz/custom, /api/quiz/attempts, /api/rag/courses) con la cabecera x-session-id.
 * CSP con nonce: sin scripts ni estilos externos, y solo conecta con este origen
 * (cabeceras y escape en teacher-page-utils.ts, compartidos con /docente/monitor).
 */

export function renderTeacherQuizPageHtml(nonce: string) {
  const courseOptions = RAG_COURSES
    .map((course) => `<option value="${escapeHtml(course.code)}">${escapeHtml(course.code)} - ${escapeHtml(course.name)}</option>`)
    .join("");

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>ADACEEN - Quices del docente</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #172033;
        --muted: #4a5868;
        --panel: #ffffff;
        --line: #d5dee8;
        --accent: #0f766e;
        --accent-strong: #0b5f59;
        --accent-soft: #e3f7f3;
        --warn: #8a4b00;
        --warn-soft: #fff4e5;
        --bad: #a3242a;
        --bad-soft: #fdecec;
        --good: #166534;
        --good-soft: #e7f6ec;
        --focus: #1d4ed8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
        color: var(--ink);
        background: #f3f6fa;
        line-height: 1.45;
      }
      header {
        background: var(--panel);
        border-bottom: 1px solid var(--line);
        padding: 14px 24px;
        display: flex;
        flex-wrap: wrap;
        gap: 12px 24px;
        align-items: center;
        justify-content: space-between;
      }
      header h1 { margin: 0; font-size: 1.25rem; }
      header p { margin: 2px 0 0; color: var(--muted); font-size: 0.92rem; }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 20px 24px 48px;
        display: grid;
        gap: 20px;
        grid-template-columns: minmax(320px, 440px) 1fr;
      }
      @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 18px 20px;
      }
      h2 { margin: 0 0 10px; font-size: 1.05rem; }
      h3 { margin: 14px 0 6px; font-size: 0.95rem; }
      label { display: block; font-weight: 600; font-size: 0.88rem; margin: 10px 0 4px; }
      input[type="text"], input[type="email"], input[type="password"], textarea, select {
        width: 100%;
        font: inherit;
        padding: 8px 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
        color: var(--ink);
      }
      textarea { min-height: 64px; resize: vertical; }
      :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
      .option-row { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; margin-top: 6px; }
      .option-row input[type="radio"] { width: 18px; height: 18px; margin: 0; }
      .hint { color: var(--muted); font-size: 0.84rem; margin: 4px 0 0; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
      button {
        font: inherit;
        font-weight: 600;
        padding: 8px 14px;
        border-radius: 8px;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        cursor: pointer;
      }
      button:hover { background: var(--accent-strong); }
      button.ghost { background: #fff; color: var(--accent-strong); }
      button.ghost:hover { background: var(--accent-soft); }
      button.danger { background: #fff; color: var(--bad); border-color: #e3b1b4; }
      button.danger:hover { background: var(--bad-soft); }
      button.small { padding: 5px 10px; font-size: 0.84rem; }
      button[disabled] { opacity: 0.55; cursor: default; }
      .notice { border-radius: 8px; padding: 8px 12px; font-size: 0.9rem; margin-top: 10px; }
      .notice.ok { background: var(--good-soft); color: var(--good); }
      .notice.warn { background: var(--warn-soft); color: var(--warn); }
      .notice.bad { background: var(--bad-soft); color: var(--bad); }
      .notice:empty { display: none; }
      .session-box { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; font-size: 0.9rem; }
      .chip { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-strong); font-size: 0.8rem; font-weight: 600; }
      .chip.warn { background: var(--warn-soft); color: var(--warn); }
      .chip.bad { background: var(--bad-soft); color: var(--bad); }
      .chip.good { background: var(--good-soft); color: var(--good); }
      .quiz-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
      .quiz-item { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
      .quiz-item.is-active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
      .quiz-head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; justify-content: space-between; }
      .quiz-topic { font-weight: 700; }
      .quiz-question { margin: 6px 0 4px; }
      .quiz-options { margin: 0; padding-left: 20px; font-size: 0.9rem; }
      .quiz-options li.correct { color: var(--good); font-weight: 600; }
      .quiz-meta { color: var(--muted); font-size: 0.84rem; margin-top: 6px; }
      .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
      table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 0.88rem; }
      th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e3e9ef; vertical-align: top; line-height: 1.4; }
      th + th, td + td { border-left: 1px solid #edf1f5; }
      th { background: #f1f5f8; color: var(--muted); font-weight: 700; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.04em; border-bottom-color: var(--line); }
      th + th { border-left-color: var(--line); }
      th:first-child, td:first-child { padding-left: 14px; }
      th:last-child, td:last-child { padding-right: 14px; }
      tbody tr:last-child > td { border-bottom: 0; }
      tbody tr:hover > td { background: #f8fafc; }
      #attemptsTable td:last-child { white-space: nowrap; }
      .toolbar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-bottom: 10px; }
      .toolbar label { margin: 0; display: inline; font-weight: 600; font-size: 0.86rem; }
      .toolbar select, .toolbar input { width: auto; max-width: 260px; }
      .empty { color: var(--muted); font-size: 0.9rem; margin: 6px 0; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      details.login { margin-top: 8px; }
      details.login summary { cursor: pointer; font-weight: 600; font-size: 0.9rem; }
      .login-form { display: grid; gap: 4px; max-width: 360px; }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>Quices del docente</h1>
        <p>Escribe o genera preguntas, guardalas en tu banco y lanzalas a la clase; abajo, los quices hechos por tus estudiantes.</p>
      </div>
      <div class="session-box" id="sessionBox">
        <span class="chip warn" id="sessionChip">Buscando tu sesion de ADACEEN...</span>
        <span id="sessionUser"></span>
        <details class="login" id="loginBox" hidden>
          <summary>Iniciar sesion con correo y contrasena</summary>
          <form class="login-form" id="loginForm" autocomplete="on">
            <label for="loginEmail">Correo</label>
            <input id="loginEmail" type="email" required autocomplete="username" />
            <label for="loginPassword">Contrasena</label>
            <input id="loginPassword" type="password" required autocomplete="current-password" />
            <div class="actions"><button type="submit" id="loginBtn">Entrar</button></div>
          </form>
        </details>
      </div>
    </header>
    <main>
      <section aria-labelledby="builderTitle">
        <h2 id="builderTitle">Nuevo quiz</h2>
        <form id="quizForm">
          <input type="hidden" id="editingId" value="" />
          <label for="courseCode">Curso</label>
          <select id="courseCode">${courseOptions}</select>
          <label for="topic">Tema</label>
          <input id="topic" type="text" maxlength="300" placeholder="Ej.: encapsulamiento en C++" required />
          <p class="hint">Con solo el tema, «Generar pregunta» la escribe por ti usando el RAG del curso; luego la puedes corregir.</p>
          <label for="question">Pregunta</label>
          <textarea id="question" maxlength="400" placeholder="Que hace...?"></textarea>
          <fieldset style="border:0;padding:0;margin:0">
            <legend class="sr-only">Opciones (marca la correcta)</legend>
            <label>Opciones <span class="hint" style="display:inline">(marca la correcta)</span></label>
            <div id="optionRows"></div>
          </fieldset>
          <div class="actions">
            <button type="button" class="ghost small" id="addOptionBtn">Agregar opcion</button>
          </div>
          <label for="explanation">Explicacion (se muestra tras responder)</label>
          <textarea id="explanation" maxlength="600"></textarea>
          <label for="followupQuestion">Pregunta abierta de seguimiento</label>
          <input id="followupQuestion" type="text" maxlength="300" placeholder="Explica con tus palabras..." />
          <div class="actions">
            <button type="button" class="ghost" id="generateBtn">Generar pregunta</button>
            <button type="submit" id="saveBtn">Guardar en mi banco</button>
            <button type="button" class="ghost" id="saveLaunchBtn">Guardar y lanzar</button>
            <button type="button" class="ghost" id="cancelEditBtn" hidden>Cancelar edicion</button>
          </div>
          <div class="notice" id="formNotice" role="status" aria-live="polite"></div>
        </form>
      </section>
      <div style="display:grid;gap:20px">
        <section aria-labelledby="bankTitle">
          <div class="toolbar">
            <h2 id="bankTitle" style="margin:0">Mis quices</h2>
            <label for="bankCourseFilter">Curso</label>
            <select id="bankCourseFilter"><option value="">Todos</option>${courseOptions}</select>
            <button type="button" class="ghost small" id="refreshBtn">Actualizar</button>
          </div>
          <div class="notice" id="bankNotice" role="status" aria-live="polite"></div>
          <ul class="quiz-list" id="bankList"></ul>
          <p class="empty" id="bankEmpty" hidden>Todavia no tienes quices guardados. Crea el primero a la izquierda.</p>
        </section>
        <section aria-labelledby="attemptsTitle">
          <div class="toolbar">
            <h2 id="attemptsTitle" style="margin:0">Quices hechos por estudiantes</h2>
            <label for="attemptsFilter">Buscar</label>
            <input id="attemptsFilter" type="text" placeholder="nombre, tema o pregunta" />
            <span class="chip" id="attemptsSummary"></span>
          </div>
          <div class="table-wrap">
            <table id="attemptsTable">
              <thead>
                <tr><th>Estudiante</th><th>Tema</th><th>Origen</th><th>Respuesta</th><th>Seguimiento</th><th>Fecha</th></tr>
              </thead>
              <tbody id="attemptsBody"></tbody>
            </table>
          </div>
          <p class="empty" id="attemptsEmpty" hidden>Tus estudiantes no han respondido quices todavia.</p>
        </section>
      </div>
    </main>
    <script nonce="${escapeHtml(nonce)}">
      (function () {
        "use strict";
        var SESSION_KEY = "adaceenTeacherQuizSession";
        var state = { sessionId: "", user: null, quizzes: [], launches: [], attempts: [], summary: null, busy: false };
        var $ = function (id) { return document.getElementById(id); };

        function text(value) { return value === null || value === undefined ? "" : String(value); }
        function notice(el, message, kind) {
          el.textContent = message || "";
          el.className = "notice" + (message ? " " + (kind || "ok") : "");
        }
        function formatDate(iso) {
          if (!iso) return "";
          var date = new Date(iso);
          return isNaN(date.getTime()) ? "" : date.toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
        }
        function readStoredSession() {
          try { return sessionStorage.getItem(SESSION_KEY) || ""; } catch (e) { return ""; }
        }
        function storeSession(id) {
          try { if (id) sessionStorage.setItem(SESSION_KEY, id); else sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
        }

        function api(path, options) {
          options = options || {};
          var headers = { "Accept": "application/json" };
          if (state.sessionId) headers["x-session-id"] = state.sessionId;
          if (options.body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
          return fetch(path, {
            method: options.method || "GET",
            headers: headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            credentials: "omit",
          }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (data) {
              if (!response.ok || data.ok === false) {
                var error = new Error(data.error || ("Error " + response.status));
                error.status = response.status;
                throw error;
              }
              return data;
            });
          });
        }

        // ---- Sesion ----
        function setSession(sessionId, user) {
          state.sessionId = sessionId || "";
          state.user = user || null;
          storeSession(state.sessionId);
          var chip = $("sessionChip");
          if (!state.sessionId) {
            chip.className = "chip warn";
            chip.textContent = "Sin sesion";
            $("sessionUser").textContent = "";
            $("loginBox").hidden = false;
            $("loginBox").open = true;
            return;
          }
          if (user && user.role !== "teacher") {
            chip.className = "chip bad";
            chip.textContent = "Esta pagina es solo para docentes";
            $("sessionUser").textContent = text(user.displayName || user.email);
            $("loginBox").hidden = false;
            $("loginBox").open = true;
            return;
          }
          chip.className = "chip good";
          chip.textContent = "Sesion de docente";
          $("sessionUser").textContent = user ? text(user.displayName || user.email) : "";
          $("loginBox").hidden = true;
          $("loginBox").open = false;
        }

        function adoptSession(sessionId) {
          if (!sessionId) return Promise.resolve(false);
          state.sessionId = sessionId;
          return api("/api/auth/me").then(function (data) {
            var user = data.user || (data.session && data.session.user) || null;
            setSession(sessionId, user);
            if (user && user.role === "teacher") return loadAll().then(function () { return true; });
            return false;
          }).catch(function () {
            state.sessionId = "";
            return false;
          });
        }

        var sessionFromExtension = false;
        window.addEventListener("message", function (event) {
          if (event.origin !== location.origin || !event.data || event.data.type !== "adaceen:session") return;
          var sessionId = text(event.data.sessionId);
          if (!sessionId || sessionFromExtension) return;
          sessionFromExtension = true;
          adoptSession(sessionId).then(function (ok) {
            if (!ok) { sessionFromExtension = false; setSession("", null); }
          });
        });
        window.postMessage({ type: "adaceen:session-request" }, location.origin);

        var stored = readStoredSession();
        (stored ? adoptSession(stored) : Promise.resolve(false)).then(function (ok) {
          if (ok) return;
          setTimeout(function () {
            if (!state.sessionId && !sessionFromExtension) setSession("", null);
          }, 2500);
        });

        $("loginForm").addEventListener("submit", function (event) {
          event.preventDefault();
          $("loginBtn").disabled = true;
          fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ email: $("loginEmail").value.trim(), password: $("loginPassword").value }),
          }).then(function (response) { return response.json(); }).then(function (data) {
            if (!data || !data.session || !data.session.id) throw new Error((data && data.error) || "No se pudo iniciar sesion.");
            $("loginPassword").value = "";
            return adoptSession(data.session.id).then(function (ok) {
              if (!ok) throw new Error("La cuenta no es de docente.");
            });
          }).catch(function (error) {
            notice($("formNotice"), text(error.message || error), "bad");
          }).then(function () { $("loginBtn").disabled = false; });
        });

        // ---- Formulario ----
        var MIN_OPTIONS = 3, MAX_OPTIONS = 5;
        function optionInputs() { return Array.prototype.slice.call($("optionRows").querySelectorAll("input[type=text]")); }
        function renderOptionRows(values, correctIndex) {
          var rows = $("optionRows");
          rows.textContent = "";
          var count = Math.max(MIN_OPTIONS, Math.min(MAX_OPTIONS, values.length));
          for (var i = 0; i < count; i += 1) {
            var row = document.createElement("div");
            row.className = "option-row";
            var radio = document.createElement("input");
            radio.type = "radio"; radio.name = "correct"; radio.value = String(i); radio.id = "correct" + i;
            radio.checked = i === correctIndex;
            radio.setAttribute("aria-label", "Opcion " + (i + 1) + " es la correcta");
            var input = document.createElement("input");
            input.type = "text"; input.maxLength = 220; input.value = text(values[i]);
            input.placeholder = "Opcion " + (i + 1);
            input.setAttribute("aria-label", "Texto de la opcion " + (i + 1));
            var remove = document.createElement("button");
            remove.type = "button"; remove.className = "ghost small"; remove.textContent = "Quitar";
            remove.disabled = count <= MIN_OPTIONS;
            remove.addEventListener("click", (function (index) {
              return function () {
                var current = readForm();
                current.options.splice(index, 1);
                if (current.correctIndex === index) current.correctIndex = 0;
                else if (current.correctIndex > index) current.correctIndex -= 1;
                renderOptionRows(current.options, current.correctIndex);
              };
            })(i));
            row.appendChild(radio); row.appendChild(input); row.appendChild(remove);
            rows.appendChild(row);
          }
          $("addOptionBtn").disabled = count >= MAX_OPTIONS;
        }
        function readForm() {
          var checked = $("optionRows").querySelector("input[type=radio]:checked");
          return {
            courseCode: $("courseCode").value,
            topic: $("topic").value.trim(),
            question: $("question").value.trim(),
            options: optionInputs().map(function (input) { return input.value.trim(); }),
            correctIndex: checked ? Number(checked.value) : -1,
            explanation: $("explanation").value.trim(),
            followupQuestion: $("followupQuestion").value.trim(),
          };
        }
        function fillForm(quiz) {
          $("editingId").value = quiz ? quiz.id : "";
          $("courseCode").value = quiz ? quiz.courseCode : $("courseCode").value;
          $("topic").value = quiz ? quiz.topic : "";
          $("question").value = quiz ? quiz.question : "";
          $("explanation").value = quiz ? quiz.explanation : "";
          $("followupQuestion").value = quiz ? quiz.followupQuestion : "";
          renderOptionRows(quiz ? quiz.options : ["", "", ""], quiz ? quiz.correctIndex : 0);
          $("builderTitle").textContent = quiz ? "Editar quiz" : "Nuevo quiz";
          $("saveBtn").textContent = quiz ? "Guardar cambios" : "Guardar en mi banco";
          $("cancelEditBtn").hidden = !quiz;
          notice($("formNotice"), "", "");
        }
        function validate(form, requireQuestion) {
          if (form.topic.length < 3) return "Escribe el tema (al menos 3 caracteres).";
          if (!requireQuestion) return "";
          if (form.question.length < 5) return "Escribe la pregunta (al menos 5 caracteres).";
          var filled = form.options.filter(Boolean);
          if (filled.length < MIN_OPTIONS || filled.length !== form.options.length) return "Completa al menos 3 opciones sin dejar ninguna vacia.";
          if (form.correctIndex < 0 || form.correctIndex >= form.options.length) return "Marca cual opcion es la correcta.";
          return "";
        }
        function payloadFrom(form, includeQuestion) {
          var body = { topic: form.topic, courseCode: form.courseCode };
          if (includeQuestion) {
            body.question = form.question; body.options = form.options; body.correctIndex = form.correctIndex;
            if (form.explanation) body.explanation = form.explanation;
            if (form.followupQuestion) body.followupQuestion = form.followupQuestion;
          }
          return body;
        }
        function setBusy(busy) {
          state.busy = busy;
          ["generateBtn", "saveBtn", "saveLaunchBtn", "refreshBtn"].forEach(function (id) { $(id).disabled = busy; });
        }

        $("addOptionBtn").addEventListener("click", function () {
          var current = readForm();
          if (current.options.length >= MAX_OPTIONS) return;
          current.options.push("");
          renderOptionRows(current.options, Math.max(0, current.correctIndex));
        });
        $("cancelEditBtn").addEventListener("click", function () { fillForm(null); });

        $("generateBtn").addEventListener("click", function () {
          var form = readForm();
          var error = validate(form, false);
          if (error) return notice($("formNotice"), error, "bad");
          setBusy(true);
          notice($("formNotice"), "Generando la pregunta con el RAG del curso...", "warn");
          // Se genera guardandola en el banco (POST con solo el tema) y se trae al formulario para corregirla.
          api("/api/quiz/custom", { method: "POST", body: payloadFrom(form, false) }).then(function (data) {
            return loadBank().then(function () {
              fillForm(data.quiz);
              notice($("formNotice"), "Pregunta generada y guardada en tu banco. Corrigela si hace falta y guarda los cambios.", "ok");
            });
          }).catch(function (err) { notice($("formNotice"), text(err.message || err), "bad"); })
            .then(function () { setBusy(false); });
        });

        function saveQuiz(andLaunch) {
          var form = readForm();
          var error = validate(form, true);
          if (error) return notice($("formNotice"), error, "bad");
          var editingId = $("editingId").value;
          setBusy(true);
          var request = editingId
            ? api("/api/quiz/custom/" + encodeURIComponent(editingId), { method: "PUT", body: payloadFrom(form, true) })
            : api("/api/quiz/custom", { method: "POST", body: payloadFrom(form, true) });
          request.then(function (data) {
            var quiz = data.quiz;
            if (!andLaunch) {
              fillForm(null);
              notice($("formNotice"), editingId ? "Cambios guardados." : "Quiz guardado en tu banco.", "ok");
              return loadBank();
            }
            return launchQuiz(quiz.id).then(function () { fillForm(null); });
          }).catch(function (err) { notice($("formNotice"), text(err.message || err), "bad"); })
            .then(function () { setBusy(false); });
        }
        $("quizForm").addEventListener("submit", function (event) { event.preventDefault(); saveQuiz(false); });
        $("saveLaunchBtn").addEventListener("click", function () { saveQuiz(true); });

        // ---- Banco ----
        function launchQuiz(id) {
          return api("/api/quiz/custom/" + encodeURIComponent(id) + "/launch", { method: "POST", body: {} }).then(function (data) {
            notice($("bankNotice"), data.message || "Quiz lanzado a la clase (60 minutos).", data.autoEnabled ? "warn" : "ok");
            return loadBank();
          }).catch(function (err) { notice($("bankNotice"), text(err.message || err), "bad"); });
        }
        function closeLaunch(launchId) {
          return api("/api/quiz/launches/" + encodeURIComponent(launchId) + "/close", { method: "POST", body: {} }).then(function () {
            notice($("bankNotice"), "Lanzamiento cerrado.", "ok");
            return loadBank();
          }).catch(function (err) { notice($("bankNotice"), text(err.message || err), "bad"); });
        }
        function retireQuiz(id) {
          return api("/api/quiz/custom/" + encodeURIComponent(id), { method: "DELETE" }).then(function () {
            notice($("bankNotice"), "Quiz retirado del banco.", "ok");
            if ($("editingId").value === id) fillForm(null);
            return loadBank();
          }).catch(function (err) { notice($("bankNotice"), text(err.message || err), "bad"); });
        }
        function renderBank() {
          var filter = $("bankCourseFilter").value;
          var list = $("bankList");
          list.textContent = "";
          var quizzes = state.quizzes.filter(function (quiz) { return !filter || quiz.courseCode === filter; });
          $("bankEmpty").hidden = quizzes.length > 0;
          quizzes.forEach(function (quiz) {
            var li = document.createElement("li");
            li.className = "quiz-item" + (quiz.activeLaunchId ? " is-active" : "");
            var head = document.createElement("div"); head.className = "quiz-head";
            var topic = document.createElement("span"); topic.className = "quiz-topic"; topic.textContent = quiz.topic;
            var chips = document.createElement("span");
            var course = document.createElement("span"); course.className = "chip"; course.textContent = quiz.courseCode || "Sin curso";
            chips.appendChild(course);
            if (quiz.activeLaunchId) {
              var live = document.createElement("span"); live.className = "chip good"; live.textContent = "Lanzado ahora"; live.style.marginLeft = "6px";
              chips.appendChild(live);
            }
            head.appendChild(topic); head.appendChild(chips);
            li.appendChild(head);
            var question = document.createElement("p"); question.className = "quiz-question"; question.textContent = quiz.question;
            li.appendChild(question);
            var options = document.createElement("ol"); options.className = "quiz-options";
            quiz.options.forEach(function (option, index) {
              var item = document.createElement("li");
              item.textContent = option;
              if (index === quiz.correctIndex) item.className = "correct";
              options.appendChild(item);
            });
            li.appendChild(options);
            var meta = document.createElement("p"); meta.className = "quiz-meta";
            var results = quiz.results || {};
            meta.textContent = "Lanzado " + (quiz.launchCount || 0) + " " + (quiz.launchCount === 1 ? "vez" : "veces")
              + (quiz.lastLaunchedAt ? " (ultima: " + formatDate(quiz.lastLaunchedAt) + ")" : "")
              + " | " + (results.answered || 0) + " respuestas"
              + (results.correctRate !== null && results.correctRate !== undefined ? ", " + results.correctRate + " % aciertos" : "");
            li.appendChild(meta);
            var actions = document.createElement("div"); actions.className = "actions";
            var launch = document.createElement("button"); launch.type = "button"; launch.className = "small"; launch.textContent = "Lanzar a la clase";
            launch.addEventListener("click", function () { launchQuiz(quiz.id); });
            actions.appendChild(launch);
            if (quiz.activeLaunchId) {
              var close = document.createElement("button"); close.type = "button"; close.className = "ghost small"; close.textContent = "Cerrar lanzamiento";
              close.addEventListener("click", function () { closeLaunch(quiz.activeLaunchId); });
              actions.appendChild(close);
            }
            var edit = document.createElement("button"); edit.type = "button"; edit.className = "ghost small"; edit.textContent = "Editar";
            edit.addEventListener("click", function () { fillForm(quiz); window.scrollTo({ top: 0, behavior: "smooth" }); });
            actions.appendChild(edit);
            var retire = document.createElement("button"); retire.type = "button"; retire.className = "danger small"; retire.textContent = "Retirar";
            retire.addEventListener("click", function () { retireQuiz(quiz.id); });
            actions.appendChild(retire);
            li.appendChild(actions);
            list.appendChild(li);
          });
        }
        function loadBank() {
          return api("/api/quiz/custom").then(function (data) {
            state.quizzes = data.quizzes || [];
            state.launches = data.launches || [];
            renderBank();
          });
        }

        // ---- Quices hechos ----
        function triggerLabel(attempt) {
          if (attempt.trigger === "teacher_launch") return attempt.customQuizId ? "Mi banco" : "Lanzado";
          return "Tras aceptar";
        }
        function answerLabel(attempt) {
          if (attempt.status === "skipped") return "Omitido";
          if (attempt.chosenIndex === null || attempt.chosenIndex === undefined) return "Sin responder";
          return attempt.correct ? "Correcta" : "Incorrecta";
        }
        function renderAttempts() {
          var filter = $("attemptsFilter").value.trim().toLowerCase();
          var body = $("attemptsBody");
          body.textContent = "";
          var attempts = state.attempts.filter(function (attempt) {
            if (!filter) return true;
            return [attempt.studentName, attempt.studentEmail, attempt.topic, attempt.question].join(" ").toLowerCase().indexOf(filter) >= 0;
          });
          $("attemptsEmpty").hidden = attempts.length > 0;
          var summary = state.summary || {};
          $("attemptsSummary").textContent = summary.total
            ? summary.total + " quices, " + (summary.students || 0) + " estudiantes" + (summary.correctRate !== null && summary.correctRate !== undefined ? ", " + summary.correctRate + " % aciertos" : "")
            : "";
          attempts.forEach(function (attempt) {
            var tr = document.createElement("tr");
            var cells = [
              attempt.studentName + (attempt.studentEmail ? "\\n" + attempt.studentEmail : ""),
              attempt.topic || attempt.question,
              triggerLabel(attempt),
              answerLabel(attempt),
              attempt.followupScore !== null && attempt.followupScore !== undefined ? attempt.followupScore + " / 100" : (attempt.followupAnswer ? "Sin calificar" : "-"),
              formatDate(attempt.createdAt),
            ];
            cells.forEach(function (value, index) {
              var td = document.createElement("td");
              if (index === 0 && attempt.studentEmail) {
                var name = document.createElement("div"); name.textContent = attempt.studentName;
                var email = document.createElement("div"); email.className = "hint"; email.textContent = attempt.studentEmail;
                td.appendChild(name); td.appendChild(email);
              } else {
                td.textContent = value;
                if (index === 1) td.title = attempt.question;
              }
              tr.appendChild(td);
            });
            body.appendChild(tr);
          });
        }
        function loadAttempts() {
          return api("/api/quiz/attempts?limit=500").then(function (data) {
            state.attempts = data.attempts || [];
            state.summary = data.summary || null;
            renderAttempts();
          });
        }
        function loadAll() {
          return Promise.all([loadBank(), loadAttempts()]).catch(function (err) {
            notice($("bankNotice"), text(err.message || err), "bad");
          });
        }

        $("bankCourseFilter").addEventListener("change", renderBank);
        $("attemptsFilter").addEventListener("input", renderAttempts);
        $("refreshBtn").addEventListener("click", function () { loadAll(); });
        fillForm(null);
      })();
    </script>
  </body>
</html>`;
}

export function registerTeacherQuizPageRoutes(app: express.Express) {
  app.get("/docente/quices", (_req, res) => {
    const nonce = randomBytes(16).toString("base64");
    setTeacherPageSecurityHeaders(res, nonce);
    res.send(renderTeacherQuizPageHtml(nonce));
  });
}
