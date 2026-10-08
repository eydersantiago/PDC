import { randomBytes } from "node:crypto";
import type express from "express";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import {
  evaluatePilotMonitor,
  formatPilotMonitorFields,
  monitorWindows,
  type MonitorReading,
  type PilotMonitorInput,
} from "../services/pilot-monitor.js";
import { countAliveWorkers, listListeningWorkers } from "../services/worker-heartbeat.js";
import { getLastWorker } from "../services/worker-identity.js";
import { describeWorkspaceHealth } from "./health-routes.js";
import { pilotSummary, requirePilotOperator } from "./pilot-routes.js";
import { errorMessage } from "./route-utils.js";
import { escapeHtml, setTeacherPageSecurityHeaders } from "./teacher-page-utils.js";
import { readLiveKpis } from "./telemetry-routes.js";

/**
 * Monitor en vivo del piloto en el navegador: GET /docente/monitor y GET /api/pilot/monitor.
 *
 * Es lo mismo que muestra `npm run piloto:monitor` en PowerShell (A14.2), pero sin
 * terminal ni contrasena en la linea de comandos: la abre el boton «Monitor» de la
 * pestana «Quices» del overlay en otra pestana del navegador, como «Crear quiz». La
 * sesion llega igual que en /docente/quices: el content script de la extension
 * (browser-ext-prod/inicio/pagina-quices.content.js, que corre en /docente/*) la manda
 * con postMessage ("adaceen:session") y, si no llega, la pagina muestra el inicio de
 * sesion con correo y contrasena (sesion de consola, para no cerrar la del overlay).
 *
 * La pagina solo pinta: cada 15 s pide GET /api/pilot/monitor con la cabecera
 * x-session-id y el backend arma en el propio servidor las mismas respuestas que el
 * script consulta por HTTP (/api/agent/health, /api/health, /api/pilot,
 * /api/telemetry/kpis en tres ventanas y /api/agent/backend) y las evalua con
 * src/services/pilot-monitor.ts, compartido con el script: mismas alertas y mismo texto.
 * Solo docente (su grupo) o administrador (con teacherUserId), como /api/pilot.
 * CSP con nonce: sin scripts ni estilos externos, y solo conecta con este origen.
 */

/** Intervalo de lectura de la pagina, en segundos (el script usa 30 por defecto). */
export const MONITOR_PAGE_INTERVAL_S = 15;

function reading<T>(status: number, data: T): MonitorReading<T> {
  return { status, data };
}

/**
 * Una consulta como la ve el script: si falla, queda con codigo 500 y el error en
 * data, y las demas se siguen mostrando (igual que una respuesta fallida por HTTP).
 */
async function attempt<T>(read: () => Promise<MonitorReading<T>>): Promise<MonitorReading<T>> {
  try {
    return await read();
  } catch (error) {
    return reading(500, { error: errorMessage(error) } as T);
  }
}

/** Las siete lecturas del monitor, armadas en el servidor para el grupo de un docente. */
export async function readPilotMonitorInput(
  database: AppDatabase,
  teacherUserId: string,
  now: Date,
  sessionStart: string,
): Promise<PilotMonitorInput> {
  const windows = monitorWindows(now, sessionStart);
  const kpis = (since: string) => attempt<PilotMonitorInput["session"]["data"]>(async () => reading(200, await readLiveKpis(database, { since })));
  const [health, backendHealth, pilot, session, window10, window5, inference] = await Promise.all([
    // GET /api/agent/health: en modo queue, 503 sin ningun worker vivo.
    attempt<PilotMonitorInput["health"]["data"]>(async () => {
      const aliveWorkers = countAliveWorkers();
      if (env.targetMode === "queue" && aliveWorkers === 0) return reading(503, { ok: false, reason: "sin_worker", alive_workers: 0 });
      return reading(200, { ok: true, alive_workers: aliveWorkers });
    }),
    // GET /api/health: el entorno de los estudiantes y su agente.
    attempt<PilotMonitorInput["backendHealth"]["data"]>(async () => reading(200, { ok: true, mode: env.targetMode, ...(await describeWorkspaceHealth(database)) })),
    // GET /api/pilot: bloque vigente y cohortes.
    attempt<PilotMonitorInput["pilot"]["data"]>(async () => reading(200, await pilotSummary(database, teacherUserId))),
    kpis(windows.session),
    kpis(windows.recent),
    kpis(windows.lastFive),
    // GET /api/agent/backend: servidores con latido y quien atendio el ultimo job.
    attempt<PilotMonitorInput["inference"]["data"]>(async () => reading(200, { mode: env.targetMode, worker: getLastWorker(), listening: listListeningWorkers() })),
  ]);
  return { health, backendHealth, pilot, session, window10, window5, inference };
}

export function renderTeacherMonitorPageHtml(nonce: string) {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>ADACEEN - Monitor del piloto</title>
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
      main { max-width: 1180px; margin: 0 auto; padding: 20px 24px 48px; display: grid; gap: 16px; }
      .toolbar {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        align-items: center;
      }
      .toolbar label { font-weight: 600; font-size: 0.88rem; }
      .toolbar input[type="datetime-local"] { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; }
      .toolbar .meta { color: var(--muted); font-size: 0.86rem; }
      .cards { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 16px 18px;
      }
      section.alerts { grid-column: 1 / -1; }
      section.is-bad { border-color: #e3b1b4; }
      h2 { margin: 0 0 8px; font-size: 1rem; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .big { font-size: 1.9rem; font-weight: 700; line-height: 1.1; margin: 4px 0 6px; }
      dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 0.9rem; }
      dt { color: var(--muted); }
      dd { margin: 0; }
      ul { margin: 6px 0 0; padding-left: 18px; font-size: 0.9rem; }
      ul.alert-list li { margin: 4px 0; color: var(--bad); font-weight: 600; }
      .hint { color: var(--muted); font-size: 0.84rem; margin: 6px 0 0; }
      .chip { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-strong); font-size: 0.8rem; font-weight: 600; }
      .chip.warn { background: var(--warn-soft); color: var(--warn); }
      .chip.bad { background: var(--bad-soft); color: var(--bad); }
      .chip.good { background: var(--good-soft); color: var(--good); }
      .chip.muted { background: #eef2f6; color: var(--muted); }
      button {
        font: inherit;
        font-weight: 600;
        padding: 7px 14px;
        border-radius: 8px;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        cursor: pointer;
      }
      button:hover { background: var(--accent-strong); }
      button.ghost { background: #fff; color: var(--accent-strong); }
      button.ghost:hover { background: var(--accent-soft); }
      button[disabled] { opacity: 0.55; cursor: default; }
      :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
      .notice { border-radius: 8px; padding: 8px 12px; font-size: 0.9rem; }
      .notice.ok { background: var(--good-soft); color: var(--good); }
      .notice.warn { background: var(--warn-soft); color: var(--warn); }
      .notice.bad { background: var(--bad-soft); color: var(--bad); }
      .notice:empty { display: none; }
      pre.line {
        margin: 0;
        padding: 10px 14px;
        background: #0f172a;
        color: #e2e8f0;
        border-radius: 10px;
        font-size: 0.84rem;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .session-box { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; font-size: 0.9rem; }
      details.login { margin-top: 8px; }
      details.login summary { cursor: pointer; font-weight: 600; font-size: 0.9rem; }
      .login-form { display: grid; gap: 4px; max-width: 360px; }
      .login-form label { display: block; font-weight: 600; font-size: 0.88rem; margin: 8px 0 2px; }
      .login-form input { width: 100%; font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>Monitor del piloto</h1>
        <p>Lo mismo que npm run piloto:monitor, en el navegador: cada ${MONITOR_PAGE_INTERVAL_S} s se lee el estado del backend, el modelo, el editor en la nube, el bloque, los estudiantes activos y la calidad de la telemetria, con las mismas alertas.</p>
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
            <p class="hint">Entra como sesion de consola: no cierra la sesion del overlay de la extension.</p>
          </form>
        </details>
      </div>
    </header>
    <main>
      <div class="toolbar">
        <label for="sinceInput">Inicio de la sesion</label>
        <input id="sinceInput" type="datetime-local" step="1" />
        <button type="button" class="ghost" id="readNowBtn">Leer ahora</button>
        <button type="button" class="ghost" id="pauseBtn">Pausar</button>
        <span class="meta" id="readMeta">Sin lecturas todavia.</span>
      </div>
      <div class="notice" id="pageNotice" role="status" aria-live="polite"></div>
      <pre class="line" id="monitorLine" aria-label="Linea del monitor">Esperando la primera lectura...</pre>
      <div class="cards">
        <section aria-labelledby="backendTitle" id="backendCard">
          <h2 id="backendTitle">Backend <span class="chip muted" id="backendChip">—</span></h2>
          <dl>
            <dt>Modo</dt><dd id="backendMode">—</dd>
            <dt>Worker</dt><dd id="workerText">—</dd>
          </dl>
        </section>
        <section aria-labelledby="modelTitle" id="modelCard">
          <h2 id="modelTitle">Modelo <span class="chip muted" id="modelChip">—</span></h2>
          <div class="big" id="serversCount">—</div>
          <p class="hint">servidores vivos</p>
          <ul id="serversList"></ul>
          <dl>
            <dt>Ultimo que atendio</dt><dd id="lastWorker">—</dd>
            <dt>Imagenes</dt><dd id="acceptsImages">—</dd>
          </dl>
        </section>
        <section aria-labelledby="editorTitle" id="editorCard">
          <h2 id="editorTitle">Editor en la nube <span class="chip muted" id="editorChip">—</span></h2>
          <dl>
            <dt>Proveedor</dt><dd id="editorProvider">—</dd>
            <dt>Agente conectado</dt><dd id="editorAgent">—</dd>
            <dt>Autoencendido</dt><dd id="editorAutostart">—</dd>
            <dt>Transporte</dt><dd id="editorTransport">—</dd>
          </dl>
        </section>
        <section aria-labelledby="pilotTitle" id="pilotCard">
          <h2 id="pilotTitle">Bloque del piloto</h2>
          <div class="big" id="pilotBlock">—</div>
          <p class="hint" id="pilotDescription">—</p>
          <dl>
            <dt>Cohorte A</dt><dd id="cohortA">—</dd>
            <dt>Cohorte B</dt><dd id="cohortB">—</dd>
            <dt>Sin cohorte</dt><dd id="cohortNone">—</dd>
          </dl>
        </section>
        <section aria-labelledby="studentsTitle" id="studentsCard">
          <h2 id="studentsTitle">Estudiantes activos (5 min)</h2>
          <div class="big" id="activeStudents">—</div>
          <dl>
            <dt>Con tutor</dt><dd id="withTutor">—</dd>
            <dt>Sin tutor</dt><dd id="withoutTutor">—</dd>
            <dt>Eventos de la sesion</dt><dd id="sessionEvents">—</dd>
            <dt>Ultimo evento</dt><dd id="lastEvent">—</dd>
            <dt>VS Code sin sesion</dt><dd id="anonymousClients">—</dd>
          </dl>
        </section>
        <section aria-labelledby="qualityTitle" id="qualityCard">
          <h2 id="qualityTitle">Calidad de telemetria y latencia</h2>
          <dl>
            <dt>Latencia p50 (10 min)</dt><dd id="latencyP50">—</dd>
            <dt>Respuestas sin fallo</dt><dd id="kpiT3">—</dd>
            <dt>Eventos perdidos</dt><dd id="kpiT4">—</dd>
            <dt>Duplicados</dt><dd id="kpiT5">—</dd>
          </dl>
          <p class="hint">Umbrales: p50 de 8 s o menos, sin fallo 95 % o mas, perdidos 2 % o menos, duplicados 1 % o menos.</p>
        </section>
        <section class="alerts" aria-labelledby="alertsTitle" id="alertsCard">
          <h2 id="alertsTitle">Alertas <span class="chip muted" id="alertsChip">—</span></h2>
          <p class="hint" id="alertsEmpty">Sin alertas en la ultima lectura.</p>
          <ul class="alert-list" id="alertsList" aria-live="polite"></ul>
        </section>
      </div>
    </main>
    <script nonce="${escapeHtml(nonce)}">
      (function () {
        "use strict";
        var SESSION_KEY = "adaceenTeacherMonitorSession";
        var SINCE_KEY = "adaceenTeacherMonitorSince";
        var INTERVAL_MS = ${MONITOR_PAGE_INTERVAL_S} * 1000;
        var state = { sessionId: "", user: null, teacherUserId: "", since: "", paused: false, timer: null, busy: false };
        var $ = function (id) { return document.getElementById(id); };

        function text(value) { return value === null || value === undefined ? "" : String(value); }
        function notice(el, message, kind) {
          el.textContent = message || "";
          el.className = "notice" + (message ? " " + (kind || "ok") : "");
        }
        function setChip(el, label, kind) { el.textContent = label; el.className = "chip " + (kind || "muted"); }
        function formatTime(iso) {
          if (!iso) return "—";
          var date = new Date(iso);
          return isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("es-CO", { hour12: false });
        }
        function formatDateTime(iso) {
          if (!iso) return "—";
          var date = new Date(iso);
          return isNaN(date.getTime()) ? "—" : date.toLocaleString("es-CO", { dateStyle: "short", timeStyle: "medium", hour12: false });
        }
        function number(value, digits) {
          if (value === null || value === undefined || isNaN(Number(value))) return "—";
          return Number(value).toLocaleString("es-CO", { maximumFractionDigits: digits === undefined ? 1 : digits });
        }
        function yesNo(value) { return value === true ? "Si" : value === false ? "No" : "—"; }
        function pad(value) { return String(value).padStart(2, "0"); }
        // datetime-local trabaja en hora local sin zona; se guarda y se manda en ISO.
        function toLocalInput(iso) {
          var date = new Date(iso);
          if (isNaN(date.getTime())) return "";
          return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
            + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
        }
        function readStored(key) { try { return sessionStorage.getItem(key) || ""; } catch (e) { return ""; } }
        function store(key, value) {
          try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch (e) {}
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

        // ---- Sesion (igual que /docente/quices; aqui tambien vale el administrador) ----
        function canOperate(user) { return !!user && (user.role === "teacher" || user.role === "admin"); }
        function setSession(sessionId, user) {
          state.sessionId = sessionId || "";
          state.user = user || null;
          store(SESSION_KEY, state.sessionId);
          var chip = $("sessionChip");
          if (!state.sessionId) {
            setChip(chip, "Sin sesion", "warn");
            $("sessionUser").textContent = "";
            $("loginBox").hidden = false;
            $("loginBox").open = true;
            return;
          }
          if (!canOperate(user)) {
            setChip(chip, "Esta pagina es solo para docentes y administradores", "bad");
            $("sessionUser").textContent = text(user && (user.displayName || user.email));
            $("loginBox").hidden = false;
            $("loginBox").open = true;
            return;
          }
          setChip(chip, user.role === "admin" ? "Sesion de administrador" : "Sesion de docente", "good");
          $("sessionUser").textContent = text(user.displayName || user.email);
          $("loginBox").hidden = true;
          $("loginBox").open = false;
          if (user.role === "admin" && !state.teacherUserId) {
            notice($("pageNotice"), "Como administrador, abre esta pagina con ?teacherUserId=<id del docente> para ver el piloto de ese grupo.", "warn");
          }
        }

        function adoptSession(sessionId) {
          if (!sessionId) return Promise.resolve(false);
          state.sessionId = sessionId;
          return api("/api/auth/me").then(function (data) {
            var user = data.user || (data.session && data.session.user) || null;
            setSession(sessionId, user);
            if (canOperate(user)) { startPolling(); return true; }
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

        var stored = readStored(SESSION_KEY);
        (stored ? adoptSession(stored) : Promise.resolve(false)).then(function (ok) {
          if (ok) return;
          setTimeout(function () {
            if (!state.sessionId && !sessionFromExtension) setSession("", null);
          }, 2500);
        });

        $("loginForm").addEventListener("submit", function (event) {
          event.preventDefault();
          $("loginBtn").disabled = true;
          // sessionKind "cli": solo reemplaza las sesiones de consola de la cuenta, como el script;
          // asi no cierra la sesion del overlay del docente (una sesion de navegador por usuario).
          fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ email: $("loginEmail").value.trim(), password: $("loginPassword").value, sessionKind: "cli" }),
          }).then(function (response) { return response.json(); }).then(function (data) {
            if (!data || !data.session || !data.session.id) throw new Error((data && data.error) || "No se pudo iniciar sesion.");
            $("loginPassword").value = "";
            return adoptSession(data.session.id).then(function (ok) {
              if (!ok) throw new Error("La cuenta no es de docente ni de administrador.");
            });
          }).catch(function (error) {
            notice($("pageNotice"), text(error.message || error), "bad");
          }).then(function () { $("loginBtn").disabled = false; });
        });

        // ---- Inicio de la sesion del piloto (--desde del script) ----
        state.teacherUserId = text(new URLSearchParams(location.search).get("teacherUserId")).trim();
        state.since = readStored(SINCE_KEY) || new Date().toISOString();
        if (isNaN(Date.parse(state.since))) state.since = new Date().toISOString();
        store(SINCE_KEY, state.since);
        $("sinceInput").value = toLocalInput(state.since);
        $("sinceInput").addEventListener("change", function () {
          var date = new Date($("sinceInput").value);
          if (isNaN(date.getTime())) return;
          state.since = date.toISOString();
          store(SINCE_KEY, state.since);
          readNow();
        });

        // ---- Lecturas ----
        function monitorPath() {
          var query = "desde=" + encodeURIComponent(state.since);
          if (state.teacherUserId) query += "&teacherUserId=" + encodeURIComponent(state.teacherUserId);
          return "/api/pilot/monitor?" + query;
        }
        function renderServers(modelo) {
          var list = $("serversList");
          list.textContent = "";
          modelo.servidores.forEach(function (server) {
            var li = document.createElement("li");
            li.textContent = server.etiqueta + (server.modelo ? " · " + server.modelo : "") + (server.tipos ? " · " + server.tipos : "")
              + (server.jobs !== null && server.jobs !== undefined ? " · " + server.jobs + " jobs" : "")
              + " · latido " + formatTime(server.ultimoLatido);
            list.appendChild(li);
          });
        }
        function render(data) {
          var r = data.resumen;
          var alertas = data.alertas || [];
          var now = data.leidoEn;
          $("readMeta").textContent = "Ultima lectura: " + formatDateTime(now) + " · cada " + (INTERVAL_MS / 1000) + " s" + (state.paused ? " (en pausa)" : "");
          $("monitorLine").textContent = formatTime(now) + " | " + text(data.linea);

          setChip($("backendChip"), r.backend.responde ? "Responde" : "No responde", r.backend.responde ? "good" : "bad");
          $("backendMode").textContent = r.backend.modo || "—";
          $("workerText").textContent = r.worker.ok ? "ok (" + r.worker.vivos + " con latido)" : "CAIDO (agent/health " + (r.worker.estado || "sin respuesta") + ")";
          $("backendCard").classList.toggle("is-bad", !r.backend.responde || !r.worker.ok);

          setChip($("modelChip"), r.modelo.servidoresVivos ? "Vivo" : "Sin servidores", r.modelo.servidoresVivos ? "good" : "bad");
          $("serversCount").textContent = String(r.modelo.servidoresVivos);
          renderServers(r.modelo);
          $("lastWorker").textContent = r.modelo.ultimoAtendio
            ? r.modelo.ultimoAtendio.etiqueta + (r.modelo.ultimoAtendio.vistoEn ? " (" + formatTime(r.modelo.ultimoAtendio.vistoEn) + ")" : "")
            : "Todavia ningun job";
          $("acceptsImages").textContent = r.modelo.servidoresVivos ? (r.modelo.aceptaImagenes ? "Si" : "No") : "—";
          $("modelCard").classList.toggle("is-bad", !r.modelo.servidoresVivos || r.modelo.modelos.length > 1);

          var tunnel = r.editor.proveedor === "tunnel";
          setChip($("editorChip"), !r.editor.proveedor ? "—" : (tunnel ? (r.editor.agenteConectado ? "Conectado" : "Apagado") : r.editor.proveedor), !r.editor.proveedor ? "muted" : (tunnel ? (r.editor.agenteConectado ? "good" : "bad") : "muted"));
          $("editorProvider").textContent = r.editor.proveedor || "—";
          $("editorAgent").textContent = yesNo(r.editor.agenteConectado);
          $("editorAutostart").textContent = yesNo(r.editor.autoencendido);
          $("editorTransport").textContent = r.editor.transporte || "—";
          $("editorCard").classList.toggle("is-bad", tunnel && r.editor.agenteConectado === false);

          $("pilotBlock").textContent = "Bloque " + r.piloto.bloque;
          $("pilotDescription").textContent = r.piloto.descripcion || (r.piloto.estado === 200 ? "—" : "No se pudo leer el piloto (" + r.piloto.estado + ")");
          $("cohortA").textContent = r.piloto.conteos ? String(r.piloto.conteos.A) : "—";
          $("cohortB").textContent = r.piloto.conteos ? String(r.piloto.conteos.B) : "—";
          $("cohortNone").textContent = r.piloto.conteos ? String(r.piloto.conteos.sinAsignar) : "—";

          $("activeStudents").textContent = String(r.estudiantes.activos5min);
          $("withTutor").textContent = String(r.estudiantes.porCondicion.con_tutor || 0);
          $("withoutTutor").textContent = String(r.estudiantes.porCondicion.sin_tutor || 0);
          $("sessionEvents").textContent = String(r.estudiantes.eventosSesion);
          $("lastEvent").textContent = formatDateTime(r.estudiantes.ultimoEvento);
          $("anonymousClients").textContent = String(r.estudiantes.sinUsuario);

          var q = r.calidad;
          $("latencyP50").textContent = q.latenciaP50Reciente !== null && q.latenciaP50Reciente !== undefined ? number(q.latenciaP50Reciente) + " s" : "—";
          $("kpiT3").textContent = q.sinFallo !== null && q.sinFallo !== undefined ? number(q.sinFallo) + " %" + (q.cumple.sinFallo === false ? " (no cumple)" : "") : "—";
          $("kpiT4").textContent = q.perdidos !== null && q.perdidos !== undefined ? number(q.perdidos) + " %" + (q.cumple.perdidos === false ? " (no cumple)" : "") : "—";
          $("kpiT5").textContent = q.duplicados !== null && q.duplicados !== undefined ? number(q.duplicados) + " %" + (q.cumple.duplicados === false ? " (no cumple)" : "") : "—";
          $("qualityCard").classList.toggle("is-bad", q.cumple.sinFallo === false || q.cumple.perdidos === false || q.cumple.duplicados === false || (q.latenciaP50Reciente !== null && q.latenciaP50Reciente > 8));

          setChip($("alertsChip"), alertas.length ? String(alertas.length) : "0", alertas.length ? "bad" : "good");
          $("alertsEmpty").hidden = alertas.length > 0;
          var list = $("alertsList");
          list.textContent = "";
          alertas.forEach(function (alert) {
            var li = document.createElement("li");
            li.textContent = "ALERTA: " + alert;
            list.appendChild(li);
          });
          $("alertsCard").classList.toggle("is-bad", alertas.length > 0);
          document.title = (alertas.length ? "(" + alertas.length + ") " : "") + "ADACEEN - Monitor del piloto";
        }

        function readNow() {
          if (!state.sessionId || !canOperate(state.user) || state.busy) return Promise.resolve();
          state.busy = true;
          $("readNowBtn").disabled = true;
          return api(monitorPath()).then(function (data) {
            notice($("pageNotice"), "", "");
            render(data);
          }).catch(function (error) {
            if (error.status === 401 || error.status === 403) {
              stopPolling();
              setSession("", null);
              notice($("pageNotice"), "La sesion ya no es valida. Inicia sesion nuevamente.", "bad");
              return;
            }
            notice($("pageNotice"), "No se pudo leer el monitor: " + text(error.message || error), "bad");
            $("readMeta").textContent = "Fallo la lectura de " + formatDateTime(new Date().toISOString());
          }).then(function () {
            state.busy = false;
            $("readNowBtn").disabled = false;
          });
        }
        function stopPolling() {
          if (state.timer) clearInterval(state.timer);
          state.timer = null;
        }
        function startPolling() {
          stopPolling();
          if (state.paused) return;
          readNow();
          state.timer = setInterval(readNow, INTERVAL_MS);
        }

        $("readNowBtn").addEventListener("click", function () { readNow(); });
        $("pauseBtn").addEventListener("click", function () {
          state.paused = !state.paused;
          $("pauseBtn").textContent = state.paused ? "Reanudar" : "Pausar";
          if (state.paused) stopPolling(); else startPolling();
        });
        // Con la pestana oculta el navegador frena los temporizadores; al volver se lee enseguida.
        document.addEventListener("visibilitychange", function () {
          if (!document.hidden && !state.paused && state.sessionId) readNow();
        });
      })();
    </script>
  </body>
</html>`;
}

// Bloque activo sin estudiantes: desde cuando, por docente (el script lo guarda en una variable).
const quietSinceByTeacher = new Map<string, number>();

export function registerTeacherMonitorPageRoutes(app: express.Express, database: AppDatabase) {
  app.get("/docente/monitor", (_req, res) => {
    const nonce = randomBytes(16).toString("base64");
    setTeacherPageSecurityHeaders(res, nonce);
    res.send(renderTeacherMonitorPageHtml(nonce));
  });

  /**
   * Una lectura del monitor para la pagina: {resumen, alertas, leidoEn, desde, linea}.
   * `desde` es el inicio de la sesion del piloto (--desde del script; por defecto ahora).
   * Docente (su grupo) o administrador con teacherUserId, como GET /api/pilot.
   */
  app.get("/api/pilot/monitor", async (req, res) => {
    try {
      const operator = await requirePilotOperator(database, req, res);
      if (!operator) return;
      const now = new Date();
      const desde = typeof req.query.desde === "string" && req.query.desde.trim() ? req.query.desde.trim() : now.toISOString();
      if (Number.isNaN(Date.parse(desde))) return res.status(400).json({ ok: false, error: `Fecha invalida: ${desde}` });
      const input = await readPilotMonitorInput(database, operator.teacherUserId, now, desde);
      const evaluation = evaluatePilotMonitor(input, { now, quietSince: quietSinceByTeacher.get(operator.teacherUserId) ?? null });
      if (evaluation.quietSince === null) quietSinceByTeacher.delete(operator.teacherUserId);
      else quietSinceByTeacher.set(operator.teacherUserId, evaluation.quietSince);
      return res.json({
        ok: true,
        resumen: evaluation.resumen,
        alertas: evaluation.alertas,
        leidoEn: now.toISOString(),
        desde,
        // La linea del script sin la hora: la pagina le pone la hora local del navegador.
        linea: formatPilotMonitorFields(evaluation.resumen).join(" | "),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}
