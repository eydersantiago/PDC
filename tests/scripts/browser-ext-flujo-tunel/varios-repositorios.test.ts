import assert from "node:assert/strict";
import test from "node:test";
import { REPO, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import { FakeElement } from "./harness-dom.js";
import { TabEnv } from "./harness-tab.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { EDITOR_KEY, savedEditorRecord, repoButton } from "./harness-helpers.js";

// ---- Un editor, varios repositorios (0.7.20) ----

const OTHER_REPO = "univalle-fpoo/taller-2";
const OTHER_TUNNEL_URL = "https://vscode.dev/tunnel/ws-alumno/home/ws-alumno/taller-2";

// Respuesta del backend 0.7.20 para OTHER_REPO: webUrl de su carpeta y los editors de la VM.
function otherRepoWorkspace(status: string, extra: Json = {}) {
  return {
    ok: status !== "error",
    provider: "tunnel",
    status,
    workspace: { login: "alumno", tunnelName: "ws-alumno", webUrl: status === "ready" ? OTHER_TUNNEL_URL : "", repoFullName: OTHER_REPO },
    editors: [
      { repoFullName: REPO, webUrl: TUNNEL_URL },
      { repoFullName: OTHER_REPO, webUrl: OTHER_TUNNEL_URL },
      { repoFullName: "otra-cuenta/ajeno", webUrl: "https://evil.example/x" },
    ],
    ...extra,
  };
}
test("0.7.20: «Abrir en mi editor» en la pagina del repositorio abre ESE repositorio en su carpeta, sin abrir el overlay", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser, { adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(browser) } });
  const tab = await openTab(browser, `https://github.com/${OTHER_REPO}`, `${OTHER_REPO}: taller 2`);

  await browser.clock.until(() => !!repoButton(tab), 50);
  const ui = repoButton(tab);
  assert.ok(ui, "boton en la pagina del repositorio");
  assert.equal(tab.run("overlayHost"), null, "sin abrir el overlay");
  assert.equal(ui!.label.textContent, "Abrir en mi editor");
  assert.match(ui!.button.title, /Agrega univalle-fpoo\/taller-2 a tu editor en la nube y lo abre\. No te pide otro codigo/);
  assert.equal(ui!.button.getAttribute("aria-label"), `Abrir en mi editor: ${OTHER_REPO}`);

  // Un clic: la ventana se abre en el mismo clic; sin editor guardado para ESTE repo va directo a
  // prepare (que lo clona en su carpeta) y abre su URL.
  browser.prepareSteps = [otherRepoWorkspace("pending", { message: "Clonando el repositorio..." })];
  browser.statusSteps = [otherRepoWorkspace("pending", { message: "Clonando el repositorio..." }), otherRepoWorkspace("ready")];
  await ui!.button.click();
  assert.equal(tab.popups.length, 1, "la ventana de espera se abre en el clic (sin bloqueo de popups)");
  await advance(browser, 400);
  assert.equal(repoButton(tab)!.label.textContent, "Preparando tu editor...");
  assert.equal(repoButton(tab)!.button.disabled, true);
  await browser.clock.until(() => tab.popups[0]?.currentHref === OTHER_TUNNEL_URL, 400);
  assert.equal(tab.popups[0].currentHref, OTHER_TUNNEL_URL, "abre la carpeta de ese repositorio");
  const prepares = browser.requests.filter((request) => request.path === "/api/workspaces/prepare");
  assert.equal(prepares.length, 1);
  assert.equal(prepares[0].body?.repoFullName, OTHER_REPO, "el repositorio de la pagina");
  await advance(browser, 400);
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");
  assert.equal(repoButton(tab)!.button.disabled, false);

  // Los dos repositorios quedan guardados (el de antes sin tocar); lo ajeno de editors no entra.
  const saved = browser.storage.adaceenEditorByUser as Record<string, Json>;
  assert.equal(saved[`${SESSION.user.id}:${OTHER_REPO}`]?.webUrl, OTHER_TUNNEL_URL);
  assert.equal(saved[EDITOR_KEY]?.webUrl, TUNNEL_URL);
  assert.equal(Object.keys(saved).some((key) => key.includes("ajeno")), false);

  // En el editor (vscode.dev) el repositorio sale de la carpeta de la URL, no del ultimo guardado.
  const editorTab = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await drive(browser, editorTab.run("syncFromStorageSnapshot({ force: true })"));
  assert.equal(editorTab.run("inferRepoFromContext(buildPayload())"), REPO);
  const otherEditorTab = await openTab(browser, `${OTHER_TUNNEL_URL}/src`, "taller-2 - Visual Studio Code");
  await drive(browser, otherEditorTab.run("syncFromStorageSnapshot({ force: true })"));
  assert.equal(otherEditorTab.run("inferRepoFromContext(buildPayload())"), OTHER_REPO);
  assert.equal(repoButton(editorTab), null, "en el editor no hay boton de GitHub");

  // Inicio: «Tus repositorios en el editor» ofrece los otros a un clic (no el de la pagina).
  // (El traspaso al editor dejo el overlay fijado y minimizado en esta pestana, como siempre.)
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  if (!tab.state().started) await drive(browser, tab.run("enterOverlayIdle('user')"));
  await browser.clock.until(() => tab.el("mainView")?.hidden === false, 200);
  assert.equal(tab.el("mainView").hidden, false);
  assert.equal(tab.el("editorReposSection").hidden, false);
  const items = tab.el("editorReposList").children;
  assert.deepEqual(items.map((item) => item.children[0].dataset.repo), [REPO]);
  browser.statusSteps = [browser.ready()];
  await tab.el("editorReposList").dispatch("click", { target: items[0].children[0] });
  await browser.clock.until(() => tab.popups[1]?.currentHref === TUNNEL_URL, 200);
  assert.equal(tab.popups[1]?.currentHref, TUNNEL_URL, "abre el otro repositorio en su carpeta");
  assertKnownShadowIds(tab, editorTab, otherEditorTab);
});

test("0.7.20: el boton aparece para cualquiera con sesion (estudiante, docente o administrador), con el tunel y en la pagina de un repositorio; sigue la navegacion de GitHub", async () => {
  // Sin sesion: ni boton ni consulta del proveedor en cada pagina de GitHub.
  const anonymous = new FakeBrowser();
  const anonTab = await openTab(anonymous, `https://github.com/${REPO}`, REPO);
  await advance(anonymous, 1000);
  assert.equal(repoButton(anonTab), null);
  assert.deepEqual(anonymous.requestsTo("/api/workspaces/provider"), []);

  // Docente y administrador: tambien (cualquier repositorio publico, propio o de un estudiante).
  for (const role of ["teacher", "admin"]) {
    const other = new FakeBrowser();
    other.session = { ...SESSION, user: { ...SESSION.user, role, assignedCourseCodes: [] } };
    seedLoggedInBrowser(other);
    const otherTab = await openTab(other, `https://github.com/${REPO}`, REPO);
    await advance(other, 1000);
    assert.ok(repoButton(otherTab), `boton para ${role}`);
    assert.equal(repoButton(otherTab)!.label.textContent, "Abrir en mi editor");
  }

  // Codespaces: el boton es del editor en la nube.
  const codespaces = new FakeBrowser();
  codespaces.provider = "codespaces";
  seedLoggedInBrowser(codespaces);
  const codespacesTab = await openTab(codespaces, `https://github.com/${REPO}`, REPO);
  await advance(codespaces, 1000);
  assert.equal(repoButton(codespacesTab), null);

  // Estudiante con el tunel: no en ajustes ni en la portada; si en el repositorio. GitHub navega
  // sin recargar (Turbo): el boton sigue la URL.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, "https://github.com/settings/profile", "Settings");
  await advance(browser, 1000);
  assert.equal(repoButton(tab), null, "github.com/settings no es un repositorio");
  const navigate = async (url: string) => {
    tab.window.location.href = url;
    await Promise.all((tab.document.listeners.get("turbo:load") || []).map((listener) => listener({ type: "turbo:load" })));
    await advance(browser, 600);
  };
  await navigate(`https://github.com/${REPO}/tree/main/src`);
  assert.ok(repoButton(tab), "pagina del repositorio (tambien dentro de una carpeta)");
  assert.match(repoButton(tab)!.button.title, new RegExp(`Prepara tu editor en la nube con ${REPO}`), "sin editores: la primera vez pide un codigo");
  await navigate("https://github.com/");
  assert.equal(repoButton(tab), null, "la portada no es un repositorio");
  await navigate(`https://github.com/${OTHER_REPO}`);
  assert.ok(repoButton(tab));
  assert.equal(tab.run("repoEditorButtonRepo"), OTHER_REPO);
  assert.ok(browser.requestsTo("/api/workspaces/provider").length <= 1, "el proveedor se consulta una vez (cache de 5 min)");
  assertKnownShadowIds(tab);
});

test("0.7.20: en la cabecera real de GitHub el boton va junto a Watch/Fork/Star (un <li> con un <span> que tiene la shadow root)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = new TabEnv(browser, `https://github.com/${REPO}`, REPO);
  // La lista de acciones de la cabecera (Watch, Fork, Star), visible.
  const actions = new FakeElement("ul", tab);
  const watch = new FakeElement("li", tab);
  actions.appendChild(watch);
  (actions as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [{ width: 300, height: 28 }];
  tab.document.body.appendChild(actions);
  tab.document.selectors.set("#repository-container-header ul.pagehead-actions", actions);
  tab.load();
  await browser.clock.settle();
  await browser.clock.until(() => !!repoButton(tab), 50);
  const host = tab.document.getElementById("adaceen-repo-editor-button");
  assert.equal(host?.tagName, "LI");
  assert.equal(host?.parentNode, actions, "dentro de la lista de acciones de la cabecera");
  assert.equal(host?.children[0]?.tagName, "SPAN", "la shadow root va en un <span>: un <li> no la admite");
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");

  // Ventana angosta: GitHub oculta la lista (d-none por debajo de md) y el boton pasa a flotar.
  (actions as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
  await Promise.all((tab.windowListeners.get("resize") || []).map((listener) => listener({ type: "resize" })));
  await advance(browser, 600);
  const floating = tab.document.getElementById("adaceen-repo-editor-button");
  assert.equal(floating?.tagName, "DIV");
  assert.equal(floating?.parentNode, tab.document.documentElement);
  assert.equal(actions.children.length, 1, "sin restos en la cabecera");
  assertKnownShadowIds(tab);
});

test("0.7.20: solo repositorios publicos: en uno privado el boton dice «Solo repos publicos» y no abre nada", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = new TabEnv(browser, `https://github.com/${OTHER_REPO}`, OTHER_REPO);
  // Lo que GitHub publica en la pagina: <meta name="octolytics-dimension-repository_public">.
  const meta = (name: string, content: string) => {
    const element = new FakeElement("meta", tab);
    element.setAttribute("name", name);
    element.setAttribute("content", content);
    tab.document.selectors.set(`meta[name="${name}"]`, element);
    return element;
  };
  const nwo = meta("octolytics-dimension-repository_nwo", OTHER_REPO);
  const visibility = meta("octolytics-dimension-repository_public", "false");
  tab.load();
  await browser.clock.settle();
  await browser.clock.until(() => !!repoButton(tab), 50);
  const ui = repoButton(tab)!;
  assert.equal(ui.label.textContent, "Solo repos publicos");
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.dataset.state, "private");
  assert.match(ui.button.title, /solo repositorios publicos/);
  await ui.button.click();
  await advance(browser, 1000);
  assert.equal(tab.popups.length, 0, "no abre la ventana de espera");
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), []);
  assert.deepEqual(browser.requestsTo("/api/workspaces/status"), []);

  // La meta de otro repositorio (pagina anterior, Turbo) no cuenta; la etiqueta de la cabecera si.
  nwo.setAttribute("content", "otra/cosa");
  const header = new FakeElement("div", tab);
  const label = new FakeElement("span", tab);
  label.textContent = "Public";
  (header as unknown as { querySelectorAll: () => FakeElement[] }).querySelectorAll = () => [label];
  tab.document.selectors.set("#repository-container-header", header);
  tab.run("syncRepoEditorButtonSoon()");
  await advance(browser, 600);
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");
  assert.equal(repoButton(tab)!.button.disabled, false);
  label.textContent = "Internal";
  tab.run("syncRepoEditorButtonSoon()");
  await advance(browser, 600);
  assert.equal(repoButton(tab)!.label.textContent, "Solo repos publicos", "interno tampoco");
  // Publico por la meta: se abre normal.
  nwo.setAttribute("content", OTHER_REPO);
  visibility.setAttribute("content", "true");
  tab.run("syncRepoEditorButtonSoon()");
  await advance(browser, 600);
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");
  assertKnownShadowIds(tab);
});

test("0.7.20 (verificacion): sin boton fuera de un repositorio, un doble clic abre una sola ventana, solo URLs del tunel y un script huerfano suelta el boton", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  // github.com/advisories/GHSA-...: dos tramos en la URL, pero GitHub no la publica como repositorio.
  const advisory = await openTab(browser, "https://github.com/advisories/GHSA-abcd-efgh-ijkl", "Advisory");
  await advance(browser, 1000);
  assert.equal(repoButton(advisory), null, "un aviso de seguridad no es un repositorio");

  // Doble clic mientras la cuenta de GitHub tarda en responder: ocupado desde el primer clic.
  const tab = await openTab(browser, `https://github.com/${OTHER_REPO}`, OTHER_REPO);
  await browser.clock.until(() => !!repoButton(tab), 50);
  browser.delays["/api/github/oauth/status"] = 1500;
  browser.prepareSteps = [otherRepoWorkspace("ready")];
  const ui = repoButton(tab)!;
  await ui.button.click();
  assert.equal(repoButton(tab)!.label.textContent, "Preparando tu editor...", "ocupado desde el clic");
  assert.equal(repoButton(tab)!.button.disabled, true);
  await ui.button.click();
  assert.equal(await tab.run(`openMyTunnelEditor({ repoFullName: "${OTHER_REPO}" })`), false, "el overlay tampoco abre otra");
  await browser.clock.until(() => tab.popups[0]?.currentHref === OTHER_TUNNEL_URL, 400);
  assert.equal(tab.popups.length, 1, "una sola ventana de espera");
  assert.equal(browser.requestsTo("/api/workspaces/prepare").length, 1, "un solo prepare");
  delete browser.delays["/api/github/oauth/status"];
  await advance(browser, 600);
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");

  // La ventana de espera solo navega a VS Code Tunnels, aunque el backend diga otra cosa.
  browser.prepareSteps = [{ ...otherRepoWorkspace("ready"), workspace: { ...(otherRepoWorkspace("ready").workspace as Json), webUrl: "https://evil.example/tunnel/x" } }];
  const storedBefore = JSON.stringify(browser.storage.adaceenEditorByUser);
  await drive(browser, tab.run(`prepareTunnelWorkspace({ repoFullName: "${OTHER_REPO}" })`), 2000);
  assert.ok(tab.popups.every((popup) => !String(popup.currentHref || "").startsWith("https://evil.example")), "no navega fuera del tunel");
  assert.equal(JSON.stringify(browser.storage.adaceenEditorByUser), storedBefore, "ni la guarda");

  // La extension se recargo con la pestana abierta: el script viejo suelta su boton y no pelea
  // con el de la copia nueva.
  await advance(browser, 600);
  assert.ok(repoButton(tab));
  tab.run("delete chrome.runtime.id");
  tab.run("syncRepoEditorButtonSoon()");
  await advance(browser, 600);
  assert.equal(repoButton(tab), null, "el huerfano quita su boton");
  const fresh = new FakeElement("div", tab);
  fresh.id = "adaceen-repo-editor-button";
  tab.document.documentElement.appendChild(fresh);
  await Promise.all((tab.document.listeners.get("turbo:load") || []).map((listener) => listener({ type: "turbo:load" })));
  await advance(browser, 600);
  assert.equal(tab.document.getElementById("adaceen-repo-editor-button"), fresh, "no toca el boton de la copia nueva");
});
