// Dibujos de las pantallas de la primera vez (0.8.4): lo que el estudiante ve en GitHub y en
// vscode.dev en los pasos 3 y 4, con el boton que tiene que pulsar resaltado (anillo ambar y
// numero). Los avisos de las paginas (shadow DOM) muestran el dibujo del paso en curso y un clic
// lo amplia.
//
// Por que dibujos y no capturas: vscode.dev y github.com no dejan cargar imagenes de otro origen
// (su CSP) y una captura queda vieja en cuanto GitHub o VS Code cambian un color o un texto. Un
// SVG en linea se ve nitido en cualquier resolucion (Retina, 4K, zoom del navegador) y sigue la
// forma de la pantalla: solo las palabras que importan son legibles y el resto son barras.
//
// Todo el markup es fijo (nada de la pagina ni del backend entra aqui). Los textos de VS Code van
// en ingles y en espanol porque vscode.dev sigue el idioma del navegador; GitHub solo en ingles.

// ---- Piezas de los dibujos (viewBox 0 0 320 200) ----

// Un solo nombre global para las piezas (devuelven SVG en texto): no se confunden con las
// funciones de guide-kit.js que leen nodos reales de la pagina. Todo texto se escapa.
const GUIDE_SVG = (() => {
  const FONT = "'Segoe UI', Arial, sans-serif";
  const AMBER = "#ffb020";
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function text(x, y, value, { size = 10, weight = 400, fill = "#cccccc", anchor = "start" } = {}) {
    return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escape(value)}</text>`;
  }

  function bar(x, y, width, { fill = "#3c3c3c", height = 5 } = {}) {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${fill}"/>`;
  }

  // Anillo ambar alrededor de lo que hay que pulsar, con su halo.
  function ring(x, y, width, height) {
    return `<rect x="${x - 5}" y="${y - 5}" width="${width + 10}" height="${height + 10}" rx="9" fill="none" stroke="${AMBER}" stroke-opacity="0.35" stroke-width="7"/>`
      + `<rect x="${x - 3}" y="${y - 3}" width="${width + 6}" height="${height + 6}" rx="7" fill="none" stroke="${AMBER}" stroke-width="2.5"/>`;
  }

  // Marca fina (sin halo) para algo pequeno pegado al borde, como un item de la barra de estado.
  function ringTight(x, y, width, height) {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="3" fill="none" stroke="${AMBER}" stroke-width="1.6"/>`;
  }

  function badge(cx, cy, label) {
    return `<circle cx="${cx}" cy="${cy}" r="10" fill="${AMBER}" stroke="#06131b" stroke-width="2"/>`
      + text(cx, cy + 4, label, { size: 11, weight: 800, fill: "#1b1300", anchor: "middle" });
  }

  // Recuadro oscuro con la instruccion (letra grande: se lee en la miniatura), centrado en `cx` y
  // del ancho del texto, y una linea al anillo si `toX`/`toY` (solo donde no cruza otro boton).
  function callout(cx, y, label, { toX, toY } = {}) {
    const width = Math.min(304, Math.round(String(label).length * 7.3 + 26));
    const x = Math.min(Math.max(cx - width / 2, 8), 312 - width);
    const line = Number.isFinite(toX) && Number.isFinite(toY)
      ? `<line x1="${toX}" y1="${toY}" x2="${Math.min(Math.max(toX, x + 12), x + width - 12)}" y2="${y}" stroke="${AMBER}" stroke-width="2"/>`
      : "";
    return line
      + `<rect x="${x}" y="${y}" width="${width}" height="28" rx="7" fill="#06131b" stroke="${AMBER}" stroke-width="1.5"/>`
      + text(x + width / 2, y + 19, label, { size: 13, weight: 700, fill: "#ffffff", anchor: "middle" });
  }

  function button(x, y, width, height, label, { fill = "#0078d4", color = "#ffffff", stroke = "", size = 10, weight = 600 } = {}) {
    const border = stroke ? ` stroke="${stroke}"` : "";
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="${fill}"${border}/>`
      + text(x + width / 2, y + height / 2 + size * 0.36, label, { size, weight, fill: color, anchor: "middle" });
  }

  return Object.freeze({ AMBER, escape, text, bar, ring, ringTight, badge, callout, button });
})();

// Los dibujos, cada uno con su titulo y su pie; solo GUIDE_FIGURES queda en el scope global.
const GUIDE_FIGURES = (() => {
  const { AMBER, text, bar, ring, ringTight, badge, callout, button } = GUIDE_SVG;

  // Ventana de VS Code en oscuro: barra de titulo, barra de actividades, area del editor y barra
  // de estado. `explorer` dibuja los archivos del ejercicio a la izquierda.
  function vscodeWindowArt({ explorer = false, dim = false, statusItem = "" } = {}) {
    const parts = [
      `<rect x="0.5" y="0.5" width="319" height="199" rx="10" fill="#1f1f1f" stroke="#3a3a3a"/>`,
      `<path d="M10 0.5 H310 A9.5 9.5 0 0 1 319.5 10 V16 H0.5 V10 A9.5 9.5 0 0 1 10 0.5 Z" fill="#181818"/>`,
      bar(130, 6, 60, { fill: "#2f2f2f", height: 5 }),
      `<rect x="0.5" y="16" width="22" height="176" fill="#181818"/>`,
      ...[26, 46, 66, 86].map((y) => `<rect x="6" y="${y}" width="11" height="11" rx="2" fill="#5a5a5a"/>`),
      `<circle cx="11.5" cy="176" r="5.5" fill="#5a5a5a"/>`,
    ];
    if (explorer) {
      parts.push(
        `<rect x="22.5" y="16" width="92" height="176" fill="#1b1b1b"/>`,
        text(30, 30, "EXPLORADOR", { size: 7, weight: 700, fill: "#9d9d9d" }),
        text(30, 46, "▾ taller-1", { size: 9, weight: 700, fill: "#cccccc" }),
      );
      const files = [["main.cpp", "#519aba"], ["Persona.h", "#a074c4"], ["Persona.cpp", "#519aba"], ["README.md", "#8c8c8c"]];
      files.forEach(([name, color], index) => {
        const y = 60 + index * 15;
        parts.push(`<rect x="38" y="${y - 7}" width="7" height="8" rx="1.5" fill="${color}"/>`, text(49, y, name, { size: 9, fill: "#cccccc" }));
      });
    }
    const codeX = explorer ? 126 : 34;
    parts.push(`<rect x="${codeX - 4}" y="16" width="${explorer ? 66 : 70}" height="14" fill="#1f1f1f" stroke="#2b2b2b"/>`);
    [[40, 70, "#569cd6"], [52, 110, "#9cdcfe"], [64, 90, "#ce9178"], [76, 130, "#9cdcfe"], [88, 60, "#c586c0"], [100, 100, "#9cdcfe"], [112, 80, "#6a9955"], [124, 120, "#9cdcfe"]]
      .forEach(([y, width, color]) => parts.push(bar(codeX, y, Math.min(width, 300 - codeX), { fill: color, height: 4 })));
    // Barra de estado: sigue las esquinas redondeadas de abajo (centro de cada arco a 9,5 del borde).
    parts.push(
      `<path d="M0.7 192 H319.3 A9.5 9.5 0 0 1 310 199.5 H10 A9.5 9.5 0 0 1 0.7 192 Z" fill="#181818"/>`,
      `<path d="M0.7 192 H26.5 V199.5 H10 A9.5 9.5 0 0 1 0.7 192 Z" fill="#0078d4"/>`,
    );
    if (statusItem) parts.push(text(250, 198.5, statusItem, { size: 6.5, weight: 600, fill: "#cccccc" }));
    if (dim) parts.push(`<rect x="0.5" y="16" width="319" height="176" fill="#000000" fill-opacity="0.35"/>`);
    return parts.join("");
  }

  // Pagina de GitHub en claro: cabecera con el nombre (texto, no el logo) y la cuenta arriba a la
  // derecha.
  function githubPageArt({ markAccount = false } = {}) {
    const parts = [
      `<rect x="0.5" y="0.5" width="319" height="199" rx="10" fill="#ffffff" stroke="#d0d7de"/>`,
      `<path d="M10 0.5 H310 A9.5 9.5 0 0 1 319.5 10 V22 H0.5 V10 A9.5 9.5 0 0 1 10 0.5 Z" fill="#f6f8fa"/>`,
      `<line x1="0.5" y1="22" x2="319.5" y2="22" stroke="#d0d7de"/>`,
      text(12, 15, "GitHub", { size: 10, weight: 700, fill: "#1f2328" }),
      `<circle cx="302" cy="11" r="7" fill="#8c959f"/>`,
    ];
    if (markAccount) {
      parts.push(
        `<circle cx="302" cy="11" r="9.5" fill="none" stroke="${AMBER}" stroke-width="2" stroke-dasharray="3 2"/>`,
        text(288, 15, "tu cuenta", { size: 8, weight: 700, fill: "#9a6700", anchor: "end" }),
      );
    }
    return parts.join("");
  }

  // ---- Los dibujos ----

  function vscodeAllowArt() {
    return vscodeWindowArt({ dim: true })
      + `<rect x="58" y="40" width="204" height="100" rx="6" fill="#252526" stroke="#454545"/>`
      + `<circle cx="76" cy="60" r="8" fill="none" stroke="#3794ff" stroke-width="2"/>`
      + text(76, 63.5, "i", { size: 10, weight: 800, fill: "#3794ff", anchor: "middle" })
      + text(92, 58, "… quiere iniciar sesión", { size: 9.5, weight: 600, fill: "#e0e0e0" })
      + text(92, 71, "con GitHub", { size: 9.5, weight: 700, fill: "#ffffff" })
      + bar(92, 80, 120, { fill: "#3c3c3c", height: 4 })
      + button(148, 110, 50, 18, "Cancel", { fill: "#313131", color: "#cccccc", stroke: "#3c3c3c", size: 9 })
      + button(204, 110, 50, 18, "Allow", { size: 10, weight: 700 })
      + ring(204, 110, 50, 18)
      + badge(262, 104, "1")
      + callout(196, 158, "Pulsa «Allow» o «Permitir»", { toX: 229, toY: 133 });
  }

  function vscodeAccountArt() {
    return vscodeWindowArt()
      + `<rect x="70" y="22" width="180" height="84" rx="6" fill="#252526" stroke="#454545"/>`
      + `<rect x="78" y="30" width="164" height="16" rx="3" fill="#313131" stroke="#0078d4"/>`
      + bar(84, 36, 70, { fill: "#5a5a5a", height: 4 })
      + `<rect x="74" y="52" width="172" height="22" rx="3" fill="#04395e"/>`
      + `<circle cx="88" cy="63" r="6" fill="#8c8c8c"/>`
      + text(100, 67, "GitHub", { size: 11, weight: 700, fill: "#ffffff" })
      + text(234, 67, "✓", { size: 12, weight: 800, fill: "#89d185", anchor: "middle" })
      + ring(74, 52, 172, 22)
      + `<circle cx="88" cy="88" r="6" fill="#5a5a5a"/>`
      + text(100, 92, "Microsoft", { size: 11, weight: 400, fill: "#9d9d9d" })
      + text(234, 92, "✗", { size: 12, weight: 800, fill: "#f48771", anchor: "middle" })
      + badge(256, 50, "1")
      + callout(160, 150, "Elige GitHub, nunca Microsoft");
  }

  function githubAuthorizeArt({ device = false } = {}) {
    const top = device ? 40 : 34;
    return githubPageArt({ markAccount: true })
      + (device ? text(160, 34, "Device activation", { size: 8, weight: 600, fill: "#59636e", anchor: "middle" }) : "")
      + `<circle cx="140" cy="${top + 12}" r="10" fill="#dfe5ea"/>`
      + `<circle cx="180" cy="${top + 12}" r="10" fill="#dfe5ea"/>`
      + text(160, top + 15, "• • •", { size: 8, weight: 700, fill: "#8c959f", anchor: "middle" })
      + text(160, top + 40, "Authorize Visual Studio Code", { size: 12, weight: 700, fill: "#1f2328", anchor: "middle" })
      + text(160, top + 53, "Visual Studio Code by Microsoft wants to access your account", { size: 6.5, fill: "#59636e", anchor: "middle" })
      + bar(100, top + 60, 120, { fill: "#eaeef2", height: 5 })
      + bar(112, top + 70, 96, { fill: "#eaeef2", height: 5 })
      + button(96, top + 82, 128, 22, "Authorize …", { fill: "#1f883d", size: 11, weight: 700 })
      + ring(96, top + 82, 128, 22)
      + badge(232, top + 80, "2")
      + callout(160, 162, "Botón verde: «Authorize»", { toX: 160, toY: top + 109 });
  }

  function vscodeTrustArt() {
    return vscodeWindowArt({ dim: true })
      + `<rect x="44" y="28" width="232" height="124" rx="6" fill="#252526" stroke="#454545"/>`
      + `<path d="M64 38 L74 42 V50 C74 56 69 60 64 62 C59 60 54 56 54 50 V42 Z" fill="none" stroke="#3794ff" stroke-width="2"/>`
      + text(82, 47, "¿Confía en los autores de los", { size: 9.5, weight: 700, fill: "#ffffff" })
      + text(82, 59, "archivos de esta carpeta?", { size: 9.5, weight: 700, fill: "#ffffff" })
      + bar(82, 66, 150, { fill: "#3c3c3c", height: 4 })
      + bar(82, 74, 110, { fill: "#3c3c3c", height: 4 })
      + button(56, 90, 208, 22, "Sí, confío en los autores", { size: 10.5, weight: 700 })
      + ring(56, 90, 208, 22)
      + button(56, 120, 208, 20, "No, no confío en los autores", { fill: "#313131", color: "#cccccc", stroke: "#3c3c3c", size: 9.5 })
      + badge(272, 86, "3")
      + callout(160, 160, "En inglés: «Yes, I trust the authors»");
  }

  function vscodeFilesArt() {
    return vscodeWindowArt({ explorer: true, statusItem: "ADACEEN: Ana" })
      + ring(32, 51, 76, 62)
      + badge(112, 50, "4")
      + ringTight(247, 192.6, 54, 6.4)
      + callout(214, 146, "Ves tus archivos: «Ya entré»", { toX: 112, toY: 100 });
  }

  function githubDeviceCodeArt() {
    const boxes = [];
    const letters = ["W", "D", "J", "B", "M", "J", "H", "T"];
    letters.forEach((letter, index) => {
      const x = index < 4 ? 76 + index * 20 : 168 + (index - 4) * 20;
      boxes.push(`<rect x="${x}" y="82" width="16" height="20" rx="3" fill="#ffffff" stroke="#d0d7de"/>`, text(x + 8, 96, letter, { size: 11, weight: 700, fill: "#1f2328", anchor: "middle" }));
    });
    return githubPageArt()
      + text(160, 50, "Device activation", { size: 13, weight: 700, fill: "#1f2328", anchor: "middle" })
      + text(160, 66, "Enter the code displayed on your device", { size: 8, fill: "#59636e", anchor: "middle" })
      + boxes.join("")
      + text(160, 97, "–", { size: 12, weight: 700, fill: "#59636e", anchor: "middle" })
      + button(110, 114, 100, 22, "Continue", { fill: "#1f883d", size: 11, weight: 700 })
      + ring(110, 114, 100, 22)
      + badge(218, 112, "1")
      + callout(160, 158, "El código ya está escrito: «Continue»", { toX: 160, toY: 141 });
  }

  function githubDeviceDoneArt() {
    return githubPageArt()
      + `<circle cx="160" cy="66" r="20" fill="#1f883d"/>`
      + `<path d="M150 66 L157 73 L171 59" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
      + text(160, 106, "Congratulations, you're all set!", { size: 12, weight: 700, fill: "#1f2328", anchor: "middle" })
      + text(160, 120, "Your device is now connected.", { size: 8.5, fill: "#59636e", anchor: "middle" })
      + callout(160, 150, "Listo: la pestaña abre tu editor");
  }

  // ---- Cambiar la cuenta de VS Code (0.8.5) ----

  function vscodeTunnelCancelArt() {
    return vscodeWindowArt({ dim: true })
      + `<rect x="50" y="34" width="220" height="90" rx="6" fill="#252526" stroke="#454545"/>`
      + text(64, 54, "No se pudo encontrar el túnel", { size: 9.5, weight: 700, fill: "#ffffff" })
      + bar(64, 64, 150, { fill: "#3c3c3c", height: 4 })
      + bar(64, 73, 110, { fill: "#3c3c3c", height: 4 })
      + button(108, 94, 86, 18, "Elegir otra cuenta", { fill: "#313131", color: "#9d9d9d", stroke: "#3c3c3c", size: 8.5 })
      + button(200, 94, 60, 18, "Cancelar", { size: 9.5, weight: 700 })
      + ring(200, 94, 60, 18)
      + badge(266, 88, "1")
      + callout(196, 150, "«Cancelar», no «Elegir otra cuenta»", { toX: 230, toY: 117 });
  }

  function vscodeAccountsOpenArt() {
    return vscodeWindowArt()
      + `<circle cx="11.5" cy="176" r="5.5" fill="#8957e5"/>`
      + ring(5, 169.5, 13, 13)
      + badge(32, 164, "2")
      + callout(132, 118, "Tus cuentas: abajo a la izquierda", { toX: 18, toY: 170 });
  }

  function vscodeAccountsSignOutArt() {
    return vscodeWindowArt()
      + `<circle cx="11.5" cy="176" r="5.5" fill="#8957e5"/>`
      + `<rect x="24" y="112" width="150" height="66" rx="5" fill="#252526" stroke="#454545"/>`
      + `<rect x="28" y="118" width="142" height="18" rx="3" fill="#04395e"/>`
      + text(36, 130.5, "otra-cuenta (GitHub)", { size: 9, weight: 700, fill: "#ffffff" })
      + text(162, 130.5, "›", { size: 11, weight: 700, fill: "#ffffff", anchor: "middle" })
      + text(36, 151, "tu-cuenta (GitHub)", { size: 9, fill: "#9d9d9d" })
      + text(162, 151, "›", { size: 11, fill: "#9d9d9d", anchor: "middle" })
      + bar(36, 165, 90, { fill: "#3c3c3c", height: 4 })
      + `<rect x="176" y="112" width="132" height="48" rx="5" fill="#252526" stroke="#454545"/>`
      + bar(184, 124, 96, { fill: "#4a4a4a", height: 4 })
      + `<rect x="180" y="136" width="124" height="18" rx="3" fill="#04395e"/>`
      + text(188, 148.5, "Cerrar sesión", { size: 10, weight: 700, fill: "#ffffff" })
      + ring(180, 136, 124, 18)
      + badge(304, 132, "3")
      + callout(160, 40, "En la otra cuenta: «Cerrar sesión»", { toX: 242, toY: 131 });
  }

  function vscodeSignOutConfirmArt() {
    return vscodeWindowArt({ dim: true })
      + `<rect x="50" y="34" width="220" height="96" rx="6" fill="#252526" stroke="#454545"/>`
      + `<circle cx="68" cy="54" r="8" fill="none" stroke="#3794ff" stroke-width="2"/>`
      + text(68, 57.5, "i", { size: 10, weight: 800, fill: "#3794ff", anchor: "middle" })
      + text(84, 52, "¿Cerrar la sesión de", { size: 9.5, weight: 700, fill: "#ffffff" })
      + text(84, 65, "«otra-cuenta»?", { size: 9.5, weight: 700, fill: "#ffffff" })
      + bar(84, 74, 120, { fill: "#3c3c3c", height: 4 })
      + button(120, 100, 64, 18, "Cancelar", { fill: "#313131", color: "#cccccc", stroke: "#3c3c3c", size: 9 })
      + button(190, 100, 70, 18, "Cerrar sesión", { size: 9.5, weight: 700 })
      + ring(190, 100, 70, 18)
      + badge(266, 94, "3")
      + callout(196, 154, "Confirma: «Cerrar sesión»", { toX: 225, toY: 123 });
  }

  function githubSelectAccountArt() {
    const row = (y, login, { mine = false } = {}) => `<rect x="70" y="${y}" width="180" height="24" rx="5" fill="${mine ? "#ddf4ff" : "#ffffff"}" stroke="${mine ? "#54aeff" : "#d0d7de"}"/>`
      + `<circle cx="84" cy="${y + 12}" r="7" fill="${mine ? "#8957e5" : "#8c959f"}"/>`
      + text(98, y + 16, login, { size: 10, weight: mine ? 700 : 400, fill: "#1f2328" });
    return githubPageArt()
      + text(160, 42, "Select an account", { size: 12, weight: 700, fill: "#1f2328", anchor: "middle" })
      + text(160, 55, "to continue to Visual Studio Code", { size: 7.5, fill: "#59636e", anchor: "middle" })
      + row(64, "otra-cuenta")
      + row(92, "tu-cuenta", { mine: true })
      + ring(70, 92, 180, 24)
      + text(160, 132, "Use a different account", { size: 8.5, weight: 600, fill: "#0969da", anchor: "middle" })
      + callout(160, 154, "Elige la cuenta de tu editor", { toX: 232, toY: 121 });
  }

  // Clave -> titulo (para el lector de pantalla y el dibujo ampliado), pie y dibujo.
  return Object.freeze({
    "vscode-allow": {
      title: "VS Code pide permiso para iniciar sesión con GitHub",
      caption: "Pulsa «Allow» («Permitir» si tu VS Code está en español). Puede preguntarlo dos veces.",
      art: vscodeAllowArt,
    },
    "vscode-account": {
      title: "VS Code deja elegir con qué cuenta entrar",
      caption: "Elige GitHub. Con Microsoft, vscode.dev no encuentra tu editor.",
      art: vscodeAccountArt,
    },
    "github-authorize": {
      title: "GitHub pide autorizar «Visual Studio Code»",
      caption: "Revisa tu cuenta arriba a la derecha y pulsa el botón verde. Que diga Microsoft es normal.",
      art: () => githubAuthorizeArt(),
    },
    "vscode-trust": {
      title: "VS Code pregunta si confías en los autores",
      caption: "Pulsa «Sí, confío en los autores» («Yes, I trust the authors»).",
      art: vscodeTrustArt,
    },
    "vscode-files": {
      title: "Tu editor con los archivos del ejercicio",
      caption: "Cuando veas tus archivos y «ADACEEN» en la barra de abajo, pulsa «Ya entré».",
      art: vscodeFilesArt,
    },
    "github-device-code": {
      title: "GitHub pide el código de tu editor",
      caption: "ADACEEN escribe el código en los cuadros. Pulsa «Continue».",
      art: githubDeviceCodeArt,
    },
    "github-device-authorize": {
      title: "GitHub pide autorizar «Visual Studio Code» para tu editor",
      caption: "Revisa que arriba a la derecha esté tu cuenta y pulsa el botón verde «Authorize».",
      art: () => githubAuthorizeArt({ device: true }),
    },
    "github-device-done": {
      title: "GitHub confirma que tu editor quedó autorizado",
      caption: "No hay que pulsar nada: en unos segundos se abre tu editor.",
      art: githubDeviceDoneArt,
    },
    "vscode-tunnel-cancel": {
      title: "VS Code dice que no encuentra el túnel",
      caption: "Pulsa «Cancelar». «Elegir otra cuenta» vuelve a usar la misma sesión.",
      art: vscodeTunnelCancelArt,
    },
    "vscode-accounts-open": {
      title: "El ícono de cuentas de VS Code",
      caption: "Abajo a la izquierda, encima del engranaje. Puede verse como tu foto de GitHub.",
      art: vscodeAccountsOpenArt,
    },
    "vscode-accounts-signout": {
      title: "Cerrar la sesión de la otra cuenta en VS Code",
      caption: "En la cuenta que no es la de tu editor, pulsa «Cerrar sesión» (Sign Out). La tuya no se toca.",
      art: vscodeAccountsSignOutArt,
    },
    "vscode-signout-confirm": {
      title: "VS Code pide confirmar que cierras la sesión",
      caption: "Pulsa «Cerrar sesión» (Sign Out). Tus archivos no se tocan.",
      art: vscodeSignOutConfirmArt,
    },
    "github-select-account": {
      title: "GitHub pregunta con qué cuenta entrar a VS Code",
      caption: "Elige la cuenta de tu editor. Si no está, «Use a different account» y entra con ella.",
      art: githubSelectAccountArt,
    },
  });
})();

function hasGuideFigure(key) {
  return Object.prototype.hasOwnProperty.call(GUIDE_FIGURES, key);
}

// El SVG de un dibujo. Decorativo (dentro de un boton que ya dice que es) o con su titulo.
function guideFigureSvg(key, { decorative = false } = {}) {
  if (!hasGuideFigure(key)) return "";
  const figure = GUIDE_FIGURES[key];
  const title = GUIDE_SVG.escape(figure.title);
  const a11y = decorative ? ' aria-hidden="true" focusable="false"' : ` role="img" aria-label="${title}"`;
  return `<svg class="guide-art" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"${a11y}>`
    + `${decorative ? "" : `<title>${title}</title>`}${figure.art()}</svg>`;
}

// ---- Dibujo del paso y dibujo ampliado (en el shadow DOM de cada aviso) ----

// Hueco del dibujo: un boton con el SVG (un clic lo amplia) y su pie. Ids fijos: cada aviso
// tiene su propio shadow root.
function guideFigureSlotMarkup() {
  return `<figure class="guide-figure" id="adaceenGuideFigure" hidden>`
    + `<button type="button" class="guide-figure-open" id="adaceenGuideFigureOpen" aria-label="Ampliar el dibujo"></button>`
    + `<figcaption class="guide-figure-caption" id="adaceenGuideFigureCaption"></figcaption>`
    + `</figure>`;
}

// Dibujo ampliado. Va al nivel del shadow root, fuera del aviso: un aviso centrado con transform
// haria que position: fixed se mida desde el aviso y no desde la ventana.
function guideLightboxMarkup() {
  return `<div class="guide-lightbox" id="adaceenGuideLightbox" hidden>`
    + `<div class="guide-lightbox-backdrop" id="adaceenGuideLightboxBackdrop"></div>`
    + `<div class="guide-lightbox-panel" id="adaceenGuideLightboxPanel" role="dialog" aria-modal="true" aria-labelledby="adaceenGuideLightboxTitle">`
    + `<div class="guide-lightbox-head"><strong id="adaceenGuideLightboxTitle"></strong>`
    + `<button type="button" class="guide-lightbox-close" id="adaceenGuideLightboxClose">Cerrar</button></div>`
    + `<div class="guide-lightbox-art" id="adaceenGuideLightboxArt"></div>`
    + `<p class="guide-lightbox-caption" id="adaceenGuideLightboxCaption"></p>`
    + `</div></div>`;
}

const GUIDE_FIGURES_CSS = `
      .guide-figure { margin: 0; display: grid; gap: 4px; width: 232px; max-width: 100%; justify-self: end; }
      .guide-figure[hidden] { display: none; }
      .guide-figure-open { display: block; width: 100%; padding: 0; border: 1px solid rgba(224, 248, 250, 0.35);
        border-radius: 8px; background: #0b1a24; cursor: zoom-in; overflow: hidden; line-height: 0; }
      .guide-figure-open:hover { border-color: #76efe5; }
      .guide-figure-open:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      .guide-art { display: block; width: 100%; height: auto; }
      .guide-figure-caption { margin: 0; color: #b9d7df; font-size: 12px; line-height: 1.35; }
      .guide-figure-caption::after { content: " · Clic para ampliar"; color: #76efe5; }
      .guide-lightbox { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
        padding: 12px; box-sizing: border-box; font: 14px/1.45 "Segoe UI", Arial, sans-serif; }
      .guide-lightbox[hidden] { display: none; }
      .guide-lightbox-backdrop { position: absolute; inset: 0; background: rgba(3, 10, 15, 0.72); }
      .guide-lightbox-panel { position: relative; box-sizing: border-box; width: min(760px, 94vw); max-height: 94vh;
        overflow: auto; overscroll-behavior: contain; display: grid; gap: 10px; padding: 14px 16px 16px; border-radius: 12px;
        background: #06131b; color: #f8fbff; border: 1px solid rgba(118, 239, 229, 0.65); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55); }
      .guide-lightbox-head { position: sticky; top: -14px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
        margin: -14px -16px 0; padding: 12px 16px; background: #06131b; }
      .guide-lightbox-head strong { font-size: 15px; }
      .guide-lightbox-close { flex: none; font: inherit; font-weight: 700; border: 0; border-radius: 8px; padding: 7px 12px;
        background: #dffffb; color: #07353b; cursor: pointer; }
      .guide-lightbox-close:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      .guide-lightbox-art .guide-art { max-height: calc(88vh - 110px); width: 100%; }
      .guide-lightbox-caption { margin: 0; color: #d9eaf0; }`;

/**
 * Conecta el hueco del dibujo y el dibujo ampliado de un aviso (guideFigureSlotMarkup,
 * guideLightboxMarkup y GUIDE_FIGURES_CSS). Devuelve:
 *   show(key)  pone en el hueco el dibujo `key` ("" lo oculta); true si quedo visible
 *   open(key)  lo amplia (sin `key`, el del hueco); true si se abrio
 *   close()    cierra el ampliado y devuelve el foco al dibujo
 * Un clic en el dibujo lo amplia; «Cerrar», el fondo o Escape lo cierran. Sin el markup lo dice
 * en la consola y no hace nada; una clave desconocida tambien se avisa.
 */
function bindGuideFigures(root) {
  const figure = root?.getElementById?.("adaceenGuideFigure");
  const openButton = root?.getElementById?.("adaceenGuideFigureOpen");
  const caption = root?.getElementById?.("adaceenGuideFigureCaption");
  const lightbox = root?.getElementById?.("adaceenGuideLightbox");
  const closeButton = root?.getElementById?.("adaceenGuideLightboxClose");
  if (!figure || !openButton || !lightbox) {
    console.warn("[ADACEEN] Aviso sin hueco de dibujo: faltan guideFigureSlotMarkup() o guideLightboxMarkup().");
    return { show: () => false, open: () => false, close() {} };
  }
  const known = (key) => {
    if (hasGuideFigure(key)) return true;
    if (key) console.warn(`[ADACEEN] Dibujo de la guia desconocido: ${key}`);
    return false;
  };
  const show = (key) => {
    if (!known(key)) {
      figure.hidden = true;
      figure.setAttribute?.("data-figure", "");
      return false;
    }
    const spec = GUIDE_FIGURES[key];
    if (figure.getAttribute?.("data-figure") !== key) {
      openButton.innerHTML = guideFigureSvg(key, { decorative: true });
      figure.setAttribute?.("data-figure", key);
    }
    openButton.setAttribute?.("aria-label", `Ampliar el dibujo: ${spec.title}`);
    if (caption) caption.textContent = spec.caption;
    figure.hidden = false;
    return true;
  };
  const close = () => {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    openButton.focus?.();
  };
  const open = (key = figure.getAttribute?.("data-figure")) => {
    if (!known(key)) return false;
    const spec = GUIDE_FIGURES[key];
    const art = root.getElementById("adaceenGuideLightboxArt");
    const title = root.getElementById("adaceenGuideLightboxTitle");
    const lightboxCaption = root.getElementById("adaceenGuideLightboxCaption");
    if (art) art.innerHTML = guideFigureSvg(key);
    if (title) title.textContent = spec.title;
    if (lightboxCaption) lightboxCaption.textContent = spec.caption;
    lightbox.hidden = false;
    closeButton?.focus?.();
    return true;
  };
  // Estado inicial explicito (no depender del atributo hidden del markup).
  lightbox.hidden = true;
  openButton.addEventListener("click", () => open());
  closeButton?.addEventListener("click", close);
  root.getElementById("adaceenGuideLightboxBackdrop")?.addEventListener("click", close);
  lightbox.addEventListener("keydown", (event) => {
    if (event?.key === "Escape") {
      event.stopPropagation?.();
      close();
    }
  });
  return { show, open, close };
}
