import assert from "node:assert/strict";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { OVERLAY_SCRIPTS, BACKEND, SESSION, type Json } from "./harness-config.js";
import { TabEnv } from "./harness-tab.js";
import type { FakeBrowser } from "./harness-backend.js";

// Espera una promesa del contexto avanzando el reloj virtual (los temporizadores de la
// extension solo corren cuando la prueba avanza el tiempo).
export async function drive<T>(browser: FakeBrowser, promise: Promise<T>, maxSteps = 400): Promise<T> {
  let settled = false;
  const tracked = Promise.resolve(promise).finally(() => {
    settled = true;
  });
  await browser.clock.until(() => settled, maxSteps);
  assert.ok(settled, "la accion no termino dentro del tiempo simulado");
  return tracked;
}

// Carga los scripts y deja terminar el arranque (sincronizacion inicial con storage), como
// cuando el estudiante pulsa el icono con la pagina ya cargada.
export async function openTab(browser: FakeBrowser, url: string, title: string, files: string[] = OVERLAY_SCRIPTS) {
  const tab = new TabEnv(browser, url, title).load(files);
  await browser.clock.settle();
  return tab;
}

// Avanza el reloj virtual al menos `ms` (corren los temporizadores vencidos por el camino).
export async function advance(browser: FakeBrowser, ms: number) {
  const target = browser.clock.now + ms;
  await browser.clock.until(() => browser.clock.now >= target, 5000);
  if (browser.clock.now < target) browser.clock.now = target;
  await browser.clock.settle();
}

// Todo id pedido a una shadow root existe en su markup (el DOM falso los crea al vuelo).
export function assertKnownShadowIds(...tabs: TabEnv[]) {
  for (const tab of tabs) {
    assert.deepEqual([...tab.missingShadowIds].sort(), [], `ids inexistentes en el markup (${tab.url})`);
  }
}

export function seedLoggedInBrowser(browser: FakeBrowser, extra: Json = {}) {
  browser.storage = {
    adaceenSessionId: SESSION.id,
    adaceenActiveSessionSnapshot: {
      sessionId: SESSION.id,
      backendUrl: BACKEND,
      session: browser.session,
      policy: {},
      telemetry: [],
      updatedAt: browser.clock.now,
    },
    adaceenPrivacyAcceptedByUser: { [SESSION.user.id]: PRIVACY_POLICY_VERSION },
    adaceenClientId: "cliente-prueba-123",
    ...extra,
  };
}
