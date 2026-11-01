// Paso 4 de la primera vez en la pagina de GitHub que autoriza «Visual Studio Code» y su selector de cuentas (0.8.5).
// Movido sin cambios de tunnel-entry-guide.service.js.

// Las paginas de GitHub que abre VS Code para autorizar «Visual Studio Code» (redirect_uri de
// vscode.dev): la de autorizar, su selector de cuentas (0.8.5) o su inicio de sesion previo; en
// todas va el mismo paso 4 con la cuenta correcta (showVscodeGithubAuthorizeHelper). Devuelve la URL
// del OAuth (la de return_to si es el inicio de sesion) o null.
function parseVscodeGithubOAuthUrl(href = location.href) {
  try {
    const url = new URL(toText(href));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
    const path = url.pathname.toLowerCase();
    let oauth = url;
    if (!path.startsWith("/login/oauth/")) {
      const returnTo = toText(url.searchParams.get("return_to"));
      if (!returnTo) return null;
      oauth = new URL(returnTo, "https://github.com");
      if (oauth.hostname.toLowerCase() !== "github.com") return null;
    }
    if (!oauth.pathname.toLowerCase().startsWith("/login/oauth/")) return null;
    const redirectUri = toText(oauth.searchParams.get("redirect_uri"));
    if (!redirectUri) return null;
    const host = new URL(redirectUri).hostname.toLowerCase();
    return host === "vscode.dev" || host.endsWith(".vscode.dev") || host.includes("vscode-redirect") ? oauth : null;
  } catch {
    return null;
  }
}

// Cualquiera de esas paginas (autorizar, selector de cuentas o inicio de sesion previo).
function isVscodeGithubAuthorizePage(href = location.href) {
  return Boolean(parseVscodeGithubOAuthUrl(href));
}

// ---- Selector de cuentas de GitHub (0.8.5; funciones puras sobre un documento) ----

// «Use a different account», «Sign in to another account», «Add account»...
const GITHUB_OTHER_ACCOUNT_PATTERN = /(different|another|other) account|add (an )?account|otra cuenta|agregar (una )?cuenta/i;

// ¿El texto menciona ese login de GitHub como palabra completa? (los logins llevan letras, numeros y guiones)
function textMentionsGithubLogin(text, login) {
  const want = toText(login).toLowerCase();
  if (!want) return false;
  return toText(text).toLowerCase().split(/[^a-z0-9-]+/).includes(want);
}

// ¿Este boton es el de ese login? El login y el nombre suelen ir en elementos pegados (sin espacio en
// textContent): se mira el texto como se ve (innerText) y el de cada elemento de adentro.
function nodeMentionsGithubLogin(node, login) {
  const texts = [node?.innerText, node?.textContent, node?.getAttribute?.("aria-label"), node?.value];
  for (const child of Array.from(node?.querySelectorAll?.("*") || [])) texts.push(child?.textContent);
  return texts.some((text) => textMentionsGithubLogin(text, login));
}

// Sin selector de cuentas en pantalla.
const NO_GITHUB_ACCOUNT_PICKER = Object.freeze({ isAccountPicker: false, isEditorAccountListed: false, target: null, label: "" });

/**
 * El selector de cuentas de GitHub (VS Code lo pide con prompt=select_account cuando no tiene una
 * cuenta con la cual entrar). Siempre devuelve un objeto (NO_GITHUB_ACCOUNT_PICKER si no es esa
 * pantalla): `isAccountPicker` (la URL del OAuth lo pide y no hay boton verde de autorizar),
 * `target` (la cuenta del editor si aparece y, si no, «usar otra cuenta»), `label` (lo que dice el
 * anillo) e `isEditorAccountListed`.
 */
function detectGithubAccountPicker(doc = document, { editorLogin = "", href = location.href } = {}) {
  const oauth = parseVscodeGithubOAuthUrl(href);
  const asked = Boolean(oauth) && (/select_account/i.test(oauth.pathname) || toText(oauth.searchParams.get("prompt")).toLowerCase() === "select_account");
  if (!asked || findGithubGuideButton(doc, "authorize")) return NO_GITHUB_ACCOUNT_PICKER;
  const clickables = Array.from(doc?.querySelectorAll?.('button, a[href], [role="button"], input[type="submit"]') || []).filter(isGuideNodeVisible);
  const mine = editorLogin ? clickables.find((node) => nodeMentionsGithubLogin(node, editorLogin)) : null;
  if (mine) return { isAccountPicker: true, isEditorAccountListed: true, target: mine, label: `Elige «${editorLogin}»` };
  const other = clickables.find((node) => GITHUB_OTHER_ACCOUNT_PATTERN.test(guideNodeText(node))) || null;
  return { isAccountPicker: true, isEditorAccountListed: false, target: other, label: other ? `Pulsa «${guideNodeText(other)}»` : "" };
}

/**
 * Lo que dice el aviso de GitHub en el selector de cuentas (0.8.5). Advierte no elegir la cuenta
 * abierta en GitHub (`signedInLogin`) ni las de GitHub que se cerraron en VS Code (`signedOutLogins`),
 * salvo la del editor.
 */
function githubAccountPickerCopy({ editorLogin = "", isEditorAccountListed = false, signedInLogin = "", signedOutLogins = [] } = {}) {
  const mine = editorLogin ? `«${editorLogin}»` : "la cuenta de tu editor";
  const avoid = [...new Set([signedInLogin, ...signedOutLogins].map(toText).filter((name) => name && name.toLowerCase() !== toText(editorLogin).toLowerCase()))];
  return {
    intro: `GitHub pregunta con qué cuenta entrar a VS Code. Elige ${mine}: es la de tu editor.`,
    items: [
      isEditorAccountListed ? `Elige ${mine} en la lista.` : `${mine} no está en la lista: pulsa «Use a different account» (usar otra cuenta) y entra con ella.`,
      "Después pulsa el botón verde para autorizar «Visual Studio Code». Que diga «Microsoft» es normal: es quien hace VS Code.",
      "GitHub te devuelve solo a tu editor.",
    ],
    warning: avoid.length ? `No elijas ${avoid.map((name) => `«${name}»`).join(" ni ")}: con esa cuenta tu editor no aparece.` : "",
  };
}

async function showVscodeGithubAuthorizeHelper() {
  if (!isVscodeGithubAuthorizePage()) return false;
  const hint = await readTunnelSignInHint();
  if (!hint) return false;
  const expected = normalizeGithubLoginHint(hint.githubLogin);
  const account = tunnelEntryAccountText(expected);
  const signIn = !/^\/login\/oauth\//i.test(location.pathname);
  // 0.8.1: con otra cuenta abierta en GitHub, VS Code entraria con esa y no encontraria el editor.
  const signedIn = signIn ? "" : readGithubSignedInLogin();
  // 0.8.5: el selector de cuentas de GitHub (despues de cerrar la otra cuenta en VS Code).
  const picker = signIn ? NO_GITHUB_ACCOUNT_PICKER : detectGithubAccountPicker(document, { editorLogin: expected });
  if (picker.isAccountPicker) {
    const brake = editorAccountSwitchBrake(await readRecentEditorAccountSwitch(toText(hint.tunnelName)));
    const copy = githubAccountPickerCopy({
      editorLogin: expected,
      isEditorAccountListed: picker.isEditorAccountListed,
      signedInLogin: signedIn,
      signedOutLogins: brake.closedGithubLogins,
    });
    const { host, controller } = mountTunnelEntryGuide({
      warning: copy.warning,
      hostId: TUNNEL_ENTRY_GUIDE_GITHUB_HOST_ID,
      ariaLabel: "ADACEEN: elige tu cuenta de GitHub",
      intro: copy.intro,
      content: { kind: "list", items: copy.items, figure: "github-select-account" },
      placement: "github",
      onDone: () => {
        clearTunnelSignInHint().catch(() => {});
      },
    });
    watchGuideScreen({
      pointer: controller.pointer,
      isActive: () => host.isConnected,
      locate: () => {
        const current = detectGithubAccountPicker(document, { editorLogin: expected });
        return { target: current.target, label: current.label };
      },
      onScreen: controller.setScreen,
    });
    return true;
  }
  const warning = expected && signedIn && signedIn !== expected
    ? `Estás en GitHub como «${signedIn}», pero tu editor es de «${expected}». No autorices con esta cuenta: cambia de cuenta (tu foto, arriba a la derecha) y vuelve a entrar a tu editor.`
    : "";
  const { host, controller } = mountTunnelEntryGuide({
    warning,
    hostId: TUNNEL_ENTRY_GUIDE_GITHUB_HOST_ID,
    ariaLabel: "ADACEEN: autoriza Visual Studio Code",
    intro: signIn
      ? `GitHub te pide iniciar sesión para que VS Code entre a tu editor. Usa ${account}.`
      : `Esta página es de GitHub: autoriza «Visual Studio Code» con ${account} para entrar a tu editor.`,
    content: {
      kind: "list",
      items: signIn
        ? ["Inicia sesión con esa cuenta.", "Después pulsa el botón verde para autorizar «Visual Studio Code».", "GitHub te devuelve solo a tu editor."]
        : ["Revisa que arriba a la derecha esté tu cuenta.", "Pulsa el botón verde para autorizar «Visual Studio Code». Que diga «Microsoft» es normal: es quien hace VS Code.", "GitHub te devuelve solo a tu editor."],
      figure: "github-authorize",
    },
    placement: "github",
    onDone: () => {
      clearTunnelSignInHint().catch(() => {});
    },
  });
  // El anillo va al boton verde solo con la cuenta correcta (con otra, no hay que pulsarlo).
  if (!signIn && !warning) {
    watchGuideScreen({
      pointer: controller.pointer,
      isActive: () => host.isConnected,
      locate: () => ({ target: findGithubGuideButton(document, "authorize"), label: GITHUB_GUIDE_BUTTONS.authorize.label }),
      onScreen: controller.setScreen,
    });
  }
  return true;
}
