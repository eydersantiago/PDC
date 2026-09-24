// Pruebas de la logica pura del agente de entornos.
//   node --test deploy/gcp/workspaces/agente/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  VIDA_CODIGO_MS,
  compararTokens,
  cuerpoRespuesta,
  decidirPreparacion,
  estadoServicio,
  extraerCodigoDispositivo,
  extraerNombreTunel,
  leerConfiguracion,
  leerHosts,
  leerOrigenGit,
  leerPropiedadesSystemd,
  mensajeDeFallo,
  nombreTunel,
  normalizarLogin,
  normalizarRepo,
  repoDesdeUrl,
  resolverEstado,
  sesionIniciada,
  urlEditor,
  validarPeticionPreparar,
} from "./parse.mjs";

const LINEA_CLI = "To grant access to the server, please log into https://github.com/login/device and use code ABCD-1234";

test("login: acepta usuarios de GitHub y rechaza lo que no debe llegar al script", () => {
  assert.equal(normalizarLogin("EyderSantiago"), "eydersantiago");
  assert.equal(normalizarLogin("  ana-maria-2 "), "ana-maria-2");
  assert.equal(normalizarLogin("a".repeat(28)), "a".repeat(28));

  for (const malo of [
    "",
    "eyder@correounivalle.edu.co",
    "-empieza-con-guion",
    "a".repeat(29),
    "con espacio",
    "x;rm -rf /",
    "$(id)",
    "`id`",
    "../../etc",
    "con_guion_bajo",
    "ñandu",
    null,
    undefined,
    42,
    ["eyder"],
  ]) {
    assert.equal(normalizarLogin(malo), null, `deberia rechazar ${JSON.stringify(malo)}`);
  }
});

test("repo: owner/nombre o URL https de GitHub; siempre sale una URL https://github.com", () => {
  assert.deepEqual(normalizarRepo("eydersantiago/FadaProyecto"), {
    fullName: "eydersantiago/FadaProyecto",
    clave: "eydersantiago/fadaproyecto",
    url: "https://github.com/eydersantiago/FadaProyecto.git",
  });
  assert.equal(normalizarRepo("https://github.com/eydersantiago/FadaProyecto.git")?.fullName, "eydersantiago/FadaProyecto");
  assert.equal(normalizarRepo("https://github.com/Org-1/repo.name_x/")?.url, "https://github.com/Org-1/repo.name_x.git");
  assert.equal(normalizarRepo("owner/repo.git")?.fullName, "owner/repo");
  assert.equal(normalizarRepo("owner/.github")?.fullName, "owner/.github");

  for (const malo of [
    "",
    "solo-nombre",
    "owner/..",
    "owner/.",
    "../etc/passwd",
    "owner/repo/extra",
    "owner/re po",
    "owner/repo;id",
    "owner/$(id)",
    "-owner/repo",
    "http://github.com/owner/repo",
    "https://evil.example/owner/repo",
    "https://github.com.evil.example/owner/repo",
    "git@github.com:owner/repo.git",
    "ext::sh -c id",
    "file:///etc/passwd",
    `owner/${"r".repeat(101)}`,
    null,
    { repo: "owner/repo" },
  ]) {
    assert.equal(normalizarRepo(malo), null, `deberia rechazar ${JSON.stringify(malo)}`);
  }
});

test("nombre de tunel y URL del editor siguen la regla de nuevo-tunel.sh", () => {
  assert.equal(nombreTunel("eydersantiago"), "ad-eydersantiago");
  const largo = "abcdefghijklmnopqrstuvwxyz";
  assert.equal(nombreTunel(largo), "ad-abcdefghijklmnopq");
  assert.equal(nombreTunel(largo).length, 20);
  assert.equal(
    urlEditor("eydersantiago"),
    "https://vscode.dev/tunnel/ad-eydersantiago/home/ws-eydersantiago/proyecto",
  );
  assert.equal(urlEditor(largo), `https://vscode.dev/tunnel/ad-abcdefghijklmnopq/home/ws-${largo}/proyecto`);
});

test("codigo de dispositivo: linea del CLI, journal, colores y mensaje partido", () => {
  assert.deepEqual(extraerCodigoDispositivo(LINEA_CLI), { codigo: "ABCD-1234", url: "https://github.com/login/device" });

  const statusSystemd = [
    "● adaceen-tunnel@ws-eyder.service - ADACEEN tunel de VS Code para ws-eyder",
    "     Active: active (running) since Tue 2026-09-23 10:00:00 UTC; 8s ago",
    "Sep 23 10:00:01 adaceen-ws code[4242]: *",
    "Sep 23 10:00:02 adaceen-ws code[4242]: [2026-09-23 10:00:02] info Using GitHub for authentication, run `code tunnel user login --provider <provider>` option to change this.",
    `Sep 23 10:00:02 adaceen-ws code[4242]: ${LINEA_CLI.replace("ABCD-1234", "WDJB-MJHT")}`,
  ].join("\n");
  assert.equal(extraerCodigoDispositivo(statusSystemd)?.codigo, "WDJB-MJHT");

  const conColores = `\u001b[2m[2026-09-23]\u001b[0m ${LINEA_CLI.replace("ABCD-1234", "\u001b[1mQWER-9876\u001b[0m")}\r\n`;
  assert.equal(extraerCodigoDispositivo(conColores)?.codigo, "QWER-9876");

  const partido = "To grant access to the server, please log into https://github.com/login/device\nand use code ZXCV-5555\n";
  assert.equal(extraerCodigoDispositivo(partido)?.codigo, "ZXCV-5555");

  // Al vencer el codigo el CLI imprime otro: gana el ultimo.
  const renovado = `${LINEA_CLI}\n...\n${LINEA_CLI.replace("ABCD-1234", "NEWC-0001")}\n`;
  assert.equal(extraerCodigoDispositivo(renovado)?.codigo, "NEWC-0001");

  assert.equal(extraerCodigoDispositivo("fatal: repository not found"), null);
  assert.equal(extraerCodigoDispositivo("id 1B4E-28BA-2FA1-11D2 sin palabra clave"), null);
  assert.equal(extraerCodigoDispositivo(""), null);
  assert.equal(extraerCodigoDispositivo(undefined), null);
});

test("nombre real del tunel desde el enlace que imprime el CLI", () => {
  assert.equal(
    extraerNombreTunel("[info] Open this link in your browser https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/proyecto"),
    "ad-eyder",
  );
  assert.equal(extraerNombreTunel("  >  Open:  https://vscode.dev/tunnel/otro-nombre-2\n"), "otro-nombre-2");
  assert.equal(extraerNombreTunel("sin enlaces"), null);
});

test("sesion del CLI: 'not logged in' NO cuenta como sesion", () => {
  assert.equal(sesionIniciada("logged in with provider github\n", 0), true);
  assert.equal(sesionIniciada("not logged in\n", 1), false);
  assert.equal(sesionIniciada("not logged in\n", 0), false);
  assert.equal(sesionIniciada("logged in with provider github\n", 1), false);
  assert.equal(sesionIniciada("", 0), false);
});

test("systemd: propiedades y estado del servicio", () => {
  const propiedades = leerPropiedadesSystemd(
    "LoadState=loaded\nActiveState=active\nSubState=running\nInvocationID=0123456789abcdef0123456789ABCDEF\n",
  );
  assert.deepEqual(estadoServicio(propiedades), {
    activo: true,
    arrancando: false,
    fallido: false,
    invocacion: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(estadoServicio({ ActiveState: "activating", SubState: "auto-restart" }).arrancando, true);
  assert.equal(estadoServicio({ ActiveState: "failed", SubState: "failed" }).fallido, true);
  assert.equal(estadoServicio({ ActiveState: "active", SubState: "running", InvocationID: "x; rm" }).invocacion, "");
  assert.deepEqual(estadoServicio({}), { activo: false, arrancando: false, fallido: false, invocacion: "" });
});

test("origen del clon desde .git/config", () => {
  const configuracion = [
    "[core]",
    "\trepositoryformatversion = 0",
    '[remote "upstream"]',
    "\turl = https://github.com/otro/cosa.git",
    '[remote "origin"]',
    "\turl = https://github.com/EyderSantiago/FadaProyecto.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
  ].join("\n");
  assert.equal(leerOrigenGit(configuracion), "https://github.com/EyderSantiago/FadaProyecto.git");
  assert.equal(repoDesdeUrl(leerOrigenGit(configuracion)), "eydersantiago/fadaproyecto");
  assert.equal(repoDesdeUrl("https://x-access-token:secreto@github.com/o/r.git"), "o/r");
  assert.equal(repoDesdeUrl("git@github.com:o/r.git"), "o/r");
  assert.equal(repoDesdeUrl("https://gitlab.com/o/r.git"), null);
  assert.equal(leerOrigenGit("[core]\n\tbare = false\n"), null);
});

test("token: comparacion en tiempo constante, sin aceptar vacios", () => {
  const token = "a".repeat(40);
  assert.equal(compararTokens(token, token), true);
  assert.equal(compararTokens(`${token}b`, token), false);
  assert.equal(compararTokens("corto", token), false);
  assert.equal(compararTokens("", ""), false);
  assert.equal(compararTokens(undefined, token), false);
  assert.equal(compararTokens(token, ""), false);
});

test("POST /workspaces: validacion del cuerpo", () => {
  const ok = validarPeticionPreparar({ login: "Eyder", repo: "eyder/proyecto", force: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.login, "eyder");
  assert.equal(ok.repo.url, "https://github.com/eyder/proyecto.git");
  assert.equal(ok.forzar, true);
  assert.equal(validarPeticionPreparar({ login: "eyder", repo: "eyder/proyecto" }).forzar, false);

  assert.equal(validarPeticionPreparar(null).ok, false);
  assert.equal(validarPeticionPreparar([]).ok, false);
  assert.match(validarPeticionPreparar({ login: "eyder@correo.co", repo: "a/b" }).message, /login invalido/);
  assert.match(validarPeticionPreparar({ login: "eyder", repo: "a/b c" }).message, /repo invalido/);
  assert.match(validarPeticionPreparar({ login: "eyder", repo: "a/b", force: "si" }).message, /force/);
});

test("fallos del script: mensajes legibles para el estudiante", () => {
  const privado = mensajeDeFallo(
    "Cloning into '/home/ws-x/proyecto'...\nfatal: could not read Username for 'https://github.com': No such device or address\n",
    { codigoSalida: 128 },
  );
  assert.equal(privado.code, "clone_failed");
  assert.match(privado.message, /privado/);

  assert.equal(mensajeDeFallo("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found", { codigoSalida: 128 }).code, "clone_failed");
  assert.equal(mensajeDeFallo("login invalido: se espera el usuario de GitHub", { codigoSalida: 1 }).code, "invalid_login");
  assert.equal(mensajeDeFallo("algo", { motivo: "timeout" }).code, "timeout");
  assert.equal(mensajeDeFallo("/opt/adaceen/nuevo-tunel.sh: line 37: /etc/adaceen-ws.env: No such file or directory", { codigoSalida: 1 }).code, "vm_not_ready");

  const generico = mensajeDeFallo("linea 1\nlinea 2\nultima linea", { codigoSalida: 3 });
  assert.equal(generico.code, "script_failed");
  assert.match(generico.detail, /codigo 3/);
  assert.match(generico.detail, /ultima linea/);
});

const NADA = { usuarioExiste: false, servicio: estadoServicio({}), sesion: false };
const ARRIBA = { usuarioExiste: true, servicio: { activo: true, arrancando: false, fallido: false }, sesion: true };
const ESPERANDO_CODIGO = { usuarioExiste: true, servicio: { activo: true, arrancando: false, fallido: false }, sesion: false };

test("estado: cola, script corriendo y codigo de dispositivo (salida o journal)", () => {
  const ahora = 1_000_000_000;
  assert.match(resolverEstado({ trabajo: { fase: "en_cola", posicion: 2 }, sistema: NADA, ahora }).message, /2 antes/);

  const corriendo = resolverEstado({ trabajo: { fase: "corriendo" }, sistema: NADA, ahora });
  assert.equal(corriendo.state, "pending");

  const conCodigo = resolverEstado({
    trabajo: { fase: "corriendo", codigo: { codigo: "ABCD-1234", url: "https://github.com/login/device", vistoEn: ahora - 1000 } },
    sistema: NADA,
    ahora,
  });
  assert.equal(conCodigo.state, "device_code");
  assert.equal(conCodigo.deviceCode, "ABCD-1234");
  assert.equal(conCodigo.expiresAt, new Date(ahora - 1000 + VIDA_CODIGO_MS).toISOString());

  // Camino b: el script ya termino y el servicio espera la autorizacion.
  const journal = resolverEstado({
    trabajo: { fase: "terminado", exito: true },
    sistema: { ...ESPERANDO_CODIGO, codigoJournal: { codigo: "JOUR-0001", url: "https://github.com/login/device", vistoEn: ahora } },
    ahora,
  });
  assert.equal(journal.state, "device_code");
  assert.equal(journal.deviceCode, "JOUR-0001");

  // Gana el codigo mas reciente.
  const reciente = resolverEstado({
    trabajo: { fase: "corriendo", codigo: { codigo: "VIEJ-0001", vistoEn: ahora - 5000 } },
    sistema: { ...ESPERANDO_CODIGO, codigoJournal: { codigo: "NUEV-0002", vistoEn: ahora - 10 } },
    ahora,
  });
  assert.equal(reciente.deviceCode, "NUEV-0002");

  // Codigo vencido: no se muestra.
  const vencido = resolverEstado({
    trabajo: null,
    sistema: { ...ESPERANDO_CODIGO, codigoJournal: { codigo: "VIEJ-0001", vistoEn: ahora - VIDA_CODIGO_MS - 1 } },
    ahora,
  });
  assert.equal(vencido.state, "pending");
});

test("estado: ready solo con servicio activo Y sesion; errores claros", () => {
  const ahora = Date.now();
  assert.equal(resolverEstado({ trabajo: { fase: "terminado", exito: true }, sistema: ARRIBA, ahora }).state, "ready");
  assert.equal(resolverEstado({ trabajo: null, sistema: ARRIBA, ahora }).state, "ready");

  const fallo = resolverEstado({
    trabajo: { fase: "terminado", exito: false, fallo: { code: "clone_failed", message: "No se pudo clonar", detail: "fatal" } },
    sistema: ARRIBA,
    ahora,
  });
  assert.deepEqual(fallo, { state: "error", code: "clone_failed", message: "No se pudo clonar", detail: "fatal" });

  assert.equal(resolverEstado({ trabajo: null, sistema: NADA, ahora }).code, "not_found");
  assert.equal(resolverEstado({ trabajo: null, sistema: null, ahora }).code, "not_found");
  assert.equal(
    resolverEstado({ trabajo: null, sistema: { usuarioExiste: true, servicio: { fallido: true }, sesion: false }, ahora }).code,
    "tunnel_failed",
  );
  assert.equal(
    resolverEstado({ trabajo: null, sistema: { usuarioExiste: true, servicio: {}, sesion: true }, ahora }).code,
    "tunnel_stopped",
  );
  assert.equal(
    resolverEstado({ trabajo: null, sistema: { usuarioExiste: true, servicio: { arrancando: true }, sesion: true }, ahora }).state,
    "pending",
  );
});

test("preparar: idempotencia, force, cola y repo distinto", () => {
  const repo = normalizarRepo("eyder/proyecto");
  const ahora = Date.now();

  assert.deepEqual(decidirPreparacion({ trabajo: null, sistema: ARRIBA, repo, origen: "eyder/proyecto", ahora }), {
    accion: "responder",
    respuesta: { state: "ready" },
  });
  assert.equal(decidirPreparacion({ trabajo: null, sistema: NADA, repo, ahora }).accion, "lanzar");
  assert.equal(decidirPreparacion({ trabajo: null, sistema: NADA, repo, ahora }).respaldar, false);
  assert.deepEqual(decidirPreparacion({ trabajo: null, sistema: ARRIBA, repo, forzar: true, ahora }), {
    accion: "lanzar",
    respaldar: true,
  });

  const distinto = decidirPreparacion({ trabajo: null, sistema: ARRIBA, repo, origen: "eyder/otro", ahora });
  assert.equal(distinto.accion, "conflicto");
  assert.equal(distinto.respuesta.code, "repo_mismatch");
  assert.match(distinto.respuesta.message, /eyder\/otro/);

  const corriendo = { fase: "corriendo", repoClave: "eyder/proyecto", repoFullName: "eyder/proyecto" };
  assert.equal(decidirPreparacion({ trabajo: corriendo, repo, ahora }).accion, "esperar");
  assert.equal(decidirPreparacion({ trabajo: corriendo, repo, forzar: true, ahora }).accion, "relanzar");
  assert.equal(
    decidirPreparacion({ trabajo: { ...corriendo, repoClave: "eyder/otro" }, repo, ahora }).respuesta.code,
    "busy_other_repo",
  );

  // Un fallo anterior no impide volver a intentar.
  assert.equal(decidirPreparacion({ trabajo: { fase: "terminado", exito: false }, sistema: NADA, repo, ahora }).accion, "lanzar");
});

test("cuerpo de respuesta: device_code trae codigo, URL y vencimiento", () => {
  const cuerpo = cuerpoRespuesta(
    "eyder",
    { state: "device_code", deviceCode: "ABCD-1234", verificationUrl: "https://github.com/login/device", expiresAt: "2026-09-23T10:15:00.000Z", message: "m" },
    null,
    normalizarRepo("eyder/proyecto"),
  );
  assert.deepEqual(cuerpo, {
    login: "eyder",
    state: "device_code",
    tunnelName: "ad-eyder",
    webUrl: "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/proyecto",
    repo: "eyder/proyecto",
    deviceCode: "ABCD-1234",
    verificationUrl: "https://github.com/login/device",
    expiresAt: "2026-09-23T10:15:00.000Z",
    message: "m",
  });
  const otroNombre = cuerpoRespuesta("eyder", { state: "ready" }, { nombreTunelReal: "random-name-7" });
  assert.equal(otroNombre.webUrl, "https://vscode.dev/tunnel/random-name-7/home/ws-eyder/proyecto");
  assert.equal("deviceCode" in otroNombre, false);
});

test("configuracion: token obligatorio y nunca todas las interfaces", () => {
  assert.throws(() => leerConfiguracion({}), /AGENT_TOKEN/);
  assert.throws(() => leerConfiguracion({ AGENT_TOKEN: "corto" }), /AGENT_TOKEN/);
  const config = leerConfiguracion({ AGENT_TOKEN: "t".repeat(32), AGENT_HOST: "127.0.0.1, 10.128.0.5" });
  assert.deepEqual(config.hosts, ["127.0.0.1", "10.128.0.5"]);
  assert.equal(config.puerto, 8787);
  assert.equal(config.script, "/opt/adaceen/nuevo-tunel.sh");
  assert.equal(config.maxConcurrentes, 3);
  assert.equal(leerConfiguracion({ AGENT_TOKEN: "t".repeat(32) }).hosts[0], "127.0.0.1");

  assert.throws(() => leerHosts("0.0.0.0"), /todas las interfaces/);
  assert.throws(() => leerHosts("::"), /todas las interfaces/);
  assert.throws(() => leerHosts("adaceen-ws.internal"), /no es una IP/);
  assert.throws(() => leerConfiguracion({ AGENT_TOKEN: "t".repeat(32), AGENT_PORT: "70000" }), /AGENT_PORT/);
  assert.throws(() => leerConfiguracion({ AGENT_TOKEN: "t".repeat(32), AGENT_MAX_CONCURRENT: "-1" }), /AGENT_MAX_CONCURRENT/);
});
