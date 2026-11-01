// Entorno por tunel, paso 3 en la pagina de GitHub: el aviso del codigo, el cambio de cuenta de GitHub
// a mitad del paso (0.8.1) y la cuenta que autorizo el codigo. Constantes en workspace.service.js.

// Dibujo de la pantalla de GitHub en cada paso del codigo (guide-illustrations.js); "" sin dibujo.
function deviceCodeGuideFigure(step) {
  if (step === "code") return "github-device-code";
  if (step === "authorize") return "github-device-authorize";
  if (step === "done") return "github-device-done";
  return "";
}

/**
 * Lo que dice y hace el aviso del codigo (paso 3) en la pagina de GitHub en que esta, sin tocar el
 * DOM (0.8.4; las reglas son de la 0.7.20 y la 0.8.1):
 *   step           "signin", "code", "authorize", "done" o "failed" (githubDeviceFlowStep)
 *   expectedLogin  la cuenta de GitHub del editor (la del codigo); "" si no se sabe
 *   signedIn       la cuenta con que se esta en GitHub ahora; "" si no se ve
 *   switching      el estudiante venia de «Cambiar de cuenta»
 * Devuelve el dibujo, el texto del paso, la linea de la cuenta ({ tone: "ok" | "wrong", text } o
 * null), si la cuenta no es la del editor (entonces se ofrece «Cambiar de cuenta», el codigo no se
 * escribe solo y el anillo no marca nada), el boton que marca el anillo ({ kind, label } o null),
 * si el codigo se escribe solo y que hay que anotar (quien autoriza; el fin del cambio de cuenta).
 * Copiar el codigo, el formulario lleno y los desenlaces cambian el texto despues.
 */
function buildDeviceCodeHelperModel({ step, expectedLogin = "", signedIn = "", switching = false }) {
  const stepText = {
    signin: `Primero inicia sesion en GitHub${expectedLogin ? ` con tu cuenta «${expectedLogin}»` : ""}. Despues GitHub te pide este codigo: pegalo y autoriza.`,
    code: "Pegalo aqui y autoriza. Cuando GitHub confirme, esta pestana abrira tu editor sola.",
    authorize: "Ultimo paso: autoriza a «Visual Studio Code» en GitHub. Cuando GitHub confirme, esta pestana abrira tu editor sola.",
    done: "GitHub confirmo el codigo. En unos segundos esta pestana abre tu editor.",
  };
  // La misma cuenta en todo el camino: el tunel queda a nombre de quien autoriza el codigo, y
  // vscode.dev solo lo encuentra con esa cuenta (el fallo mas comun: «no encuentra el tunel»).
  // 0.8.1: con otra cuenta el codigo no se escribe solo (pulsar Continue dejaria el editor a
  // nombre de esa cuenta) y «Cambiar de cuenta» acompana hasta volver aqui con la correcta.
  const wrongAccount = Boolean(expectedLogin && signedIn && signedIn !== expectedLogin && step !== "done" && step !== "failed");
  let statusText = stepText[step] || stepText.code;
  if (wrongAccount) {
    statusText = step === "authorize"
      ? `No pulses «Authorize» con «${signedIn}». Pulsa «Cambiar de cuenta», entra con «${expectedLogin}» y ADACEEN te trae de vuelta al codigo.`
      : `No pegues el codigo con «${signedIn}». Pulsa «Cambiar de cuenta», entra con «${expectedLogin}» y ADACEEN te trae de vuelta aqui con el codigo.`;
  }
  let account = null;
  if (expectedLogin && signedIn && step !== "done") {
    account = signedIn === expectedLogin
      ? { tone: "ok", text: `Cuenta correcta: estas en GitHub como «${signedIn}».` }
      : { tone: "wrong", text: `Estas en GitHub como «${signedIn}», pero tu editor es de «${expectedLogin}». Cambia de cuenta antes de autorizar: con otra cuenta, vscode.dev no encontrara tu editor.` };
  }
  // El anillo va al boton verde de GitHub («Continue» o «Authorize») solo con la cuenta correcta.
  const pointerKind = wrongAccount ? "" : step === "code" ? "continue" : step === "authorize" ? "authorize" : "";
  return {
    figure: deviceCodeGuideFigure(step),
    statusText,
    account,
    wrongAccount,
    pointer: pointerKind ? { kind: pointerKind, label: GITHUB_GUIDE_BUTTONS[pointerKind].label } : null,
    // Solo en las paginas del codigo (github.com/login/device...), nunca en el inicio de sesion.
    canFill: (step === "code" || step === "authorize") && !wrongAccount,
    // Quien autoriza (o esta por autorizar) el codigo: si despues vscode.dev no encuentra el
    // editor, el aviso de vscode.dev sabe si fue por el codigo o por la entrada a vscode.dev.
    rememberDeviceAccount: Boolean(signedIn && (step === "authorize" || step === "done")),
    // Ya en la cuenta correcta despues de cambiarla: se termina el cambio.
    finishAccountSwitch: Boolean(switching && signedIn && signedIn === expectedLogin),
  };
}

// En github.com/login/device: aviso fijo con el codigo y un boton para copiarlo. Solo para el
// usuario de ADACEEN que pidio el codigo, y mientras la espera siga viva.
async function showGithubDeviceCodeHelper() {
  const step = githubDeviceFlowStep();
  // Fuera de las paginas del codigo: solo si el estudiante esta cambiando de cuenta (0.8.1).
  if (!step) return showGithubAccountSwitchHelper();
  let handoff = await readDeviceCodeHandoff();
  if (!handoff || handoff.outcome || Date.now() - handoff.aliveAt > DEVICE_CODE_HANDOFF_STALE_MS) return false;
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const userId = getCurrentUserId();
  if (!userId || handoff.userId !== userId) return false;

  document.getElementById(DEVICE_CODE_HELPER_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = DEVICE_CODE_HELPER_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; el codigo entra con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
        display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 10px 14px; box-sizing: border-box;
        width: min(780px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; overscroll-behavior: contain;
        padding: 12px 76px 12px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.55); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        font: 14px/1.4 Segoe UI, Arial, sans-serif; }
      .main { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; min-width: 0; }
      .code { font: 700 22px/1.1 ui-monospace, Consolas, monospace; letter-spacing: 2px; color: #76efe5; }
      .copy { flex: 1 1 220px; margin: 0; }
      button { font: inherit; font-weight: 700; border-radius: 8px; border: 0; padding: 8px 12px; cursor: pointer;
        background: #dffffb; color: #07353b; }
      button.close, button.minimize { position: absolute; top: 8px; background: transparent; color: #d9eaf0; padding: 4px 8px; }
      button.close { right: 8px; }
      button.minimize { right: 40px; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      .account { flex: 1 1 100%; margin: 0; font-size: 13px; color: #b9d7df; }
      .account.is-ok { color: #9ff0c6; }
      .account.is-wrong { padding: 8px 10px; border-radius: 8px; background: #3b2a06; color: #ffe2a3; border: 1px solid #c99a2e; }
      button.switch { background: #ffd08a; color: #3b2a06; }
      .head { flex: 1 1 100%; display: grid; gap: 6px; }
      .why { margin: 0; color: #d9eaf0; font-size: 13px; }
      .box .guide-figure { width: 196px; }
      .pill { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646; display: inline-flex;
        align-items: center; gap: 8px; max-width: calc(100vw - 24px); padding: 8px 14px; border-radius: 999px;
        background: #06131b; color: #f8fbff; border: 1px solid rgba(118, 239, 229, 0.55); box-shadow: 0 10px 26px rgba(0, 0, 0, 0.35);
        font: 700 13px/1.3 Segoe UI, Arial, sans-serif; white-space: nowrap; }
      .pill strong { font-family: ui-monospace, Consolas, monospace; letter-spacing: 1px; color: #76efe5; }
      @media (max-width: 640px) {
        .box { grid-template-columns: minmax(0, 1fr); }
        .box .guide-figure { justify-self: start; width: min(260px, 100%); }
      }
      @media (max-height: 640px) { .box .guide-figure-caption { display: none; } .box .guide-figure { width: 150px; } }
      ${GUIDE_FOLD_CSS}
      ${FIRST_TIME_STEPS_CSS}
      ${GUIDE_FIGURES_CSS}
      ${GUIDE_POINTER_CSS}
    </style>
    <aside class="box" id="adaceenDeviceCodeBox" role="region" aria-label="Codigo de ADACEEN para autorizar tu editor">
      <div class="main">
        <div class="head">
          <strong class="step-title">${firstTimeStepHeading("authorize")} <span class="must">· obligatorio la primera vez</span></strong>
          ${firstTimeStepsMarkup("authorize")}
          <p class="why">Sin este paso tu editor no abre: GitHub asocia el editor a tu cuenta. Hazlo con la misma cuenta de GitHub que conectaste.</p>
        </div>
        <span>ADACEEN · tu codigo</span>
        <strong class="code" id="adaceenDeviceCode"></strong>
        <button type="button" id="adaceenDeviceCodeCopy">Copiar codigo</button>
        <p class="copy" id="adaceenDeviceCodeStatus" role="status"></p>
        <p class="account" id="adaceenDeviceCodeAccount" role="status" hidden></p>
        <button type="button" class="switch" id="adaceenDeviceCodeSwitch" hidden>Cambiar de cuenta</button>
      </div>
      ${guideFigureSlotMarkup()}
      <button type="button" class="minimize" id="adaceenDeviceCodeMinimize" aria-label="Plegar el aviso" title="Plegar">&#8211;</button>
      <button type="button" class="close" id="adaceenDeviceCodeClose" aria-label="Ocultar el codigo">&times;</button>
    </aside>
    <button type="button" class="pill" id="adaceenDeviceCodePill" aria-label="Abrir el aviso de ADACEEN con tu código" hidden>
      ADACEEN · tu código <strong id="adaceenDeviceCodePillCode"></strong>
    </button>
    ${guidePointerMarkup()}
    ${guideLightboxMarkup()}`;
  const codeEl = root.getElementById("adaceenDeviceCode");
  const statusEl = root.getElementById("adaceenDeviceCodeStatus");
  const accountEl = root.getElementById("adaceenDeviceCodeAccount");
  const pillCodeEl = root.getElementById("adaceenDeviceCodePillCode");
  if (codeEl) codeEl.textContent = handoff.userCode;
  if (pillCodeEl) pillCodeEl.textContent = handoff.userCode;
  const signedIn = readGithubSignedInLogin();
  const model = buildDeviceCodeHelperModel({ step, expectedLogin: handoff.githubLogin, signedIn, switching: handoff.switching });
  const { wrongAccount } = model;
  // 0.8.4: el dibujo de la pantalla de GitHub en la que esta (codigo, autorizar o listo).
  const figures = bindGuideFigures(root);
  figures.show(model.figure);
  const pointer = bindGuidePointer(root);
  const pillEl = root.getElementById("adaceenDeviceCodePill");
  // Plegado en la pastilla con el codigo: a mano o solo, si el aviso tapa el boton de GitHub.
  const folding = createGuideFoldController({ box: root.getElementById("adaceenDeviceCodeBox"), pill: pillEl });
  wireGuideFold(folding, { minimizeButton: root.getElementById("adaceenDeviceCodeMinimize"), pill: pillEl });
  if (statusEl) statusEl.textContent = model.statusText;
  const switchEl = root.getElementById("adaceenDeviceCodeSwitch");
  if (accountEl) {
    accountEl.hidden = !model.account;
    if (model.account) {
      accountEl.className = model.account.tone === "ok" ? "account is-ok" : "account is-wrong";
      accountEl.textContent = model.account.text;
    }
  }
  if (switchEl) switchEl.hidden = !wrongAccount;
  if (model.rememberDeviceAccount) rememberTunnelDeviceAccount(handoff, signedIn).catch(() => false);
  if (model.finishAccountSwitch) updateDeviceCodeHandoff(handoff.userCode, () => ({ switching: false })).catch(() => false);
  // Una vez que ADACEEN deja de esperar, el aviso lo dice y ya no cambia.
  let settled = false;
  let staleTimer = 0;
  const settle = (text) => {
    if (settled) return;
    settled = true;
    if (staleTimer) window.clearInterval(staleTimer);
    if (statusEl) statusEl.textContent = text;
  };
  // El boton que vera en la pestana de ADACEEN: "Abrir mi editor" o, sin editor guardado,
  // "Preparar mi editor".
  const buttonLabel = () => tunnelRetryButtonLabel(handoff.repoFullName, handoff.buttonLabel);
  const stoppedText = () => `ADACEEN ya no espera este codigo. Si tu editor no se abrio, vuelve a la pestana de ADACEEN y pulsa "${buttonLabel()}".`;
  // El codigo se escribe solo en el formulario de GitHub (si se reconoce). Mientras este
  // puesto, los mensajes de copiar no lo tapan: lo unico que falta es Continue y autorizar.
  let filled = false;
  const fillForm = () => {
    if (settled || !host.isConnected) return false;
    filled = fillGithubDeviceCodeForm(handoff.userCode);
    if (filled && statusEl) statusEl.textContent = DEVICE_CODE_FILLED_TEXT;
    return filled;
  };
  // La pagina puede pintar los cuadros un instante despues de cargar: unos pocos intentos.
  const tryFill = (attempt = 0) => {
    if (!model.canFill || fillForm() || attempt >= DEVICE_CODE_FILL_ATTEMPTS - 1) return;
    window.setTimeout(() => tryFill(attempt + 1), DEVICE_CODE_FILL_RETRY_MS);
  };
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(handoff.userCode);
      if (statusEl && !settled && !filled && !wrongAccount) {
        statusEl.textContent = step === "signin"
          ? `Codigo copiado. Inicia sesion${handoff.githubLogin ? ` con «${handoff.githubLogin}»` : ""} y, cuando GitHub lo pida, pegalo y autoriza.`
          : "Codigo copiado: pegalo en el primer cuadro y autoriza. Esta pestana abrira tu editor sola.";
      }
      return true;
    } catch {
      if (statusEl && !settled && !filled && !wrongAccount && step !== "signin") statusEl.textContent = "Escribe el codigo en los cuadros y autoriza. Esta pestana abrira tu editor sola.";
      return false;
    }
  };
  root.getElementById("adaceenDeviceCodeCopy")?.addEventListener("click", () => {
    copyCode().catch(() => {});
  });
  root.getElementById("adaceenDeviceCodeClose")?.addEventListener("click", () => {
    host.remove();
  });
  switchEl?.addEventListener("click", async () => {
    // La espera sigue latiendo en la pestana de ADACEEN: el codigo vale mientras tanto.
    await updateDeviceCodeHandoff(handoff.userCode, () => ({ switching: true })).catch(() => false);
    location.href = GITHUB_LOGOUT_URL;
  });
  document.documentElement.appendChild(host);
  if (model.pointer) {
    watchGuideScreen({
      pointer,
      isActive: () => host.isConnected,
      locate: () => ({ target: findGithubGuideButton(document, model.pointer.kind), label: model.pointer.label }),
      onScreen: (screen) => folding.avoidCovering({ target: screen.target }),
    });
  }
  // GitHub rechazo el codigo (o se cancelo): no hay nada que esperar en esta pestana.
  if (step === "failed") settle(`GitHub no autorizo el codigo. Vuelve a la pestana de ADACEEN y pulsa "${buttonLabel()}" para recibir otro.`);
  tryFill();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes?.[STORAGE_KEY_DEVICE_CODE_HANDOFF] || settled || !host.isConnected) return;
    const next = normalizeDeviceCodeHandoff(changes[STORAGE_KEY_DEVICE_CODE_HANDOFF].newValue);
    if (!next) {
      // Editor listo (esta pestana navega al editor), cierre de sesion o caducidad.
      window.setTimeout(() => {
        if (host.isConnected) settle(stoppedText());
      }, DEVICE_CODE_GONE_GRACE_MS);
      return;
    }
    if (next.userId !== handoff.userId) {
      settle(stoppedText());
      return;
    }
    if (next.outcome === "error") {
      const detail = next.message ? ` ${next.message.replace(/[.\s]+$/, "")}.` : "";
      settle(`ADACEEN dejo de esperar.${detail} Vuelve a la pestana de ADACEEN y pulsa "${buttonLabel()}".`);
      return;
    }
    const newCode = next.userCode !== handoff.userCode;
    handoff = next;
    if (newCode && codeEl) {
      // GitHub emitio otro codigo en la misma espera: se muestra y se vuelve a escribir.
      codeEl.textContent = next.userCode;
      filled = false;
      if (statusEl) statusEl.textContent = "Codigo nuevo: pegalo aqui y autoriza. Cuando GitHub confirme, esta pestana abrira tu editor sola.";
      tryFill();
    }
  });
  // La pestana de origen se recargo o se cerro: la espera dejo de latir.
  staleTimer = window.setInterval(() => {
    if (!host.isConnected) {
      window.clearInterval(staleTimer);
      return;
    }
    if (Date.now() - handoff.aliveAt > DEVICE_CODE_HANDOFF_STALE_MS) settle(stoppedText());
  }, DEVICE_CODE_HELPER_CHECK_MS);

  // Mejor esfuerzo, y solo recien emitido el codigo: con la pestana activa el navegador suele
  // dejar copiar sin clic. En el inicio de sesion tambien: el codigo espera en el portapapeles.
  if ((step === "code" || step === "signin") && Date.now() - handoff.savedAt < DEVICE_CODE_AUTO_COPY_MS) {
    copyCode().catch(() => {});
  }
  return true;
}

// ---- Cambiar de cuenta de GitHub a mitad del paso 3 (0.8.1) ----

// Despues de «Cambiar de cuenta» el estudiante pasa por github.com/logout y la portada de GitHub
// (o su inicio de sesion, que ya acompana showGithubDeviceCodeHelper): aqui se dice que sigue,
// hasta volver a github.com/login/device con la cuenta del editor.
async function showGithubAccountSwitchHelper() {
  if (toText(location.hostname).toLowerCase() !== "github.com") return false;
  const handoff = await readDeviceCodeHandoff();
  if (!handoff?.switching || handoff.outcome || !handoff.githubLogin) return false;
  if (Date.now() - handoff.aliveAt > DEVICE_CODE_HANDOFF_STALE_MS) return false;
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const userId = getCurrentUserId();
  if (!userId || handoff.userId !== userId) return false;

  const expected = handoff.githubLogin;
  const signedIn = readGithubSignedInLogin();
  const onLogout = /^\/logout\/?$/i.test(toText(location.pathname));
  let text = "";
  let action = null;
  if (signedIn && signedIn === expected) {
    text = `Listo: ahora estas en GitHub como «${expected}». Volviendo al codigo...`;
    action = { label: "Seguir con el codigo", href: GITHUB_DEVICE_LOGIN_URL };
  } else if (onLogout) {
    text = `Pulsa «Sign out» en esta pagina para salir de ${signedIn ? `«${signedIn}»` : "esa cuenta"}. Despues entra con «${expected}»: ADACEEN te lleva de vuelta al codigo.`;
  } else if (signedIn) {
    text = `Sigues en GitHub como «${signedIn}». Sal de esa cuenta y entra con «${expected}».`;
    action = { label: `Salir de «${signedIn}»`, href: GITHUB_LOGOUT_URL };
  } else {
    text = `Entra a GitHub con «${expected}». Despues ADACEEN te lleva de vuelta al codigo.`;
    action = { label: `Entrar con «${expected}»`, href: GITHUB_SIGNIN_TO_DEVICE_URL };
  }

  document.getElementById(GITHUB_SWITCH_ACCOUNT_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = GITHUB_SWITCH_ACCOUNT_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; los textos entran con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
        display: grid; gap: 8px; box-sizing: border-box; width: min(640px, calc(100vw - 24px));
        padding: 12px 44px 12px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.55); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        font: 14px/1.4 Segoe UI, Arial, sans-serif; }
      p { margin: 0; color: #d9eaf0; }
      .actions { display: flex; gap: 8px; }
      button { font: inherit; font-weight: 700; border-radius: 8px; border: 0; padding: 8px 12px; cursor: pointer;
        background: #dffffb; color: #07353b; }
      button.close { position: absolute; top: 8px; right: 8px; background: transparent; color: #d9eaf0; padding: 4px 8px; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      ${FIRST_TIME_STEPS_CSS}
    </style>
    <aside class="box" role="region" aria-label="ADACEEN: cambia de cuenta de GitHub">
      <strong class="step-title">${firstTimeStepHeading("authorize")} <span class="must">· cambiar de cuenta</span></strong>
      ${firstTimeStepsMarkup("authorize")}
      <p id="adaceenSwitchText" role="status"></p>
      <div class="actions"><button type="button" id="adaceenSwitchAction" hidden></button></div>
      <button type="button" class="close" id="adaceenSwitchClose" aria-label="Ocultar el aviso">&times;</button>
    </aside>`;
  const textEl = root.getElementById("adaceenSwitchText");
  if (textEl) textEl.textContent = text;
  const actionEl = root.getElementById("adaceenSwitchAction");
  if (actionEl && action) {
    actionEl.hidden = false;
    actionEl.textContent = action.label;
    actionEl.addEventListener("click", () => {
      location.href = action.href;
    });
  }
  root.getElementById("adaceenSwitchClose")?.addEventListener("click", () => host.remove());
  document.documentElement.appendChild(host);
  if (signedIn && signedIn === expected) {
    window.setTimeout(() => {
      if (host.isConnected) location.href = GITHUB_DEVICE_LOGIN_URL;
    }, GITHUB_SWITCH_RETURN_MS);
  }
  return true;
}

// Cuenta de GitHub que autorizo el codigo del tunel, por usuario de ADACEEN (0.8.1).
async function rememberTunnelDeviceAccount(handoff, account) {
  const userId = getCurrentUserId();
  const login = normalizeGithubLoginHint(account);
  if (!userId || !login || !isExtensionRuntimeReady()) return false;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_TUNNEL_DEVICE_ACCOUNT]: {
        userId,
        expected: normalizeGithubLoginHint(handoff?.githubLogin),
        account: login,
        at: Date.now(),
        expiresAt: Date.now() + TUNNEL_DEVICE_ACCOUNT_TTL_MS,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function readTunnelDeviceAccount() {
  if (!isExtensionRuntimeReady()) return null;
  try {
    const raw = (await chrome.storage.local.get([STORAGE_KEY_TUNNEL_DEVICE_ACCOUNT]))?.[STORAGE_KEY_TUNNEL_DEVICE_ACCOUNT];
    if (!raw || !(Number(raw.expiresAt) > Date.now())) return null;
    const userId = getCurrentUserId();
    if (!userId || toText(raw.userId) !== userId) return null;
    const account = normalizeGithubLoginHint(raw.account);
    return account ? { account, expected: normalizeGithubLoginHint(raw.expected) } : null;
  } catch {
    return null;
  }
}

async function clearTunnelDeviceAccount() {
  if (!isExtensionRuntimeReady()) return;
  try {
    await chrome.storage.local.remove([STORAGE_KEY_TUNNEL_DEVICE_ACCOUNT]);
  } catch {}
}
