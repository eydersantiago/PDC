// Guia de instalacion y uso (A16.8, docs/guia-instalacion-uso.md): cada texto de
// interfaz que la guia cita entre comillas angulares («…») tiene que existir en el
// codigo que lo muestra. Asi la guia no se queda atras cuando cambia un boton o un
// mensaje.
//
// Donde se busca:
//   - browser-ext-prod (overlay, servicios, pagina de espera, background; sin el readme
//     ni el popup, que se borro en la 0.7.12),
//   - vscode-ext-prod/src (sin las pruebas) y vscode-ext-prod/package.json,
//   - src/routes/start-page-routes.ts (pagina /empezar).
// Mas dos listas explicitas:
//   - TEXTOS_DEL_SERVIDOR: mensajes que el backend o el agente de la VM mandan en la
//     respuesta y que el overlay o VS Code muestran tal cual; se buscan en su archivo.
//   - TEXTOS_EXTERNOS: textos de GitHub, Chrome, Firefox, Windows, macOS o VS Code que
//     ADACEEN no controla ni copia; no se pueden comprobar en el codigo y la guia los
//     marca "por verificar" cuando no son seguros.
// Algunos textos externos pasan sin estar en TEXTOS_EXTERNOS porque ADACEEN los copia en
// sus instrucciones: los de Chrome, macOS y VS Code de /empezar
// (TEXTOS_EXTERNOS_COPIADOS_EN_EMPEZAR) o «Permitir» del dialogo de VS Code, que cita la
// extension. De esos solo se contrasta la copia: si Chrome o macOS cambian el texto, la
// copia y la guia quedan atras juntas (la guia pide revisarlos en la validacion).
//
// Convenciones de la guia: "<...>" es una parte que cambia (nombre, archivo, codigo) y
// "…" marca un texto recortado; cada tramo fijo entre ellos debe estar en el codigo.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const RAIZ = process.cwd();
const GUIA = "docs/guia-instalacion-uso.md";

const TEXTOS_DEL_SERVIDOR: Record<string, string> = {
  // Backend: el overlay y VS Code muestran el campo message de la respuesta.
  "No se pudo clonar el repositorio: no existe o es privado.…": "deploy/gcp/workspaces/agente/parse.mjs",
  "Tu editor ya tiene clonado <repositorio>.…": "deploy/gcp/workspaces/agente/parse.mjs",
  "La cuenta de GitHub <usuario> no esta en la lista del piloto. Pide al docente que la agregue.": "src/services/workspace-provider.ts",
  "Tu conexion con GitHub ya no es valida.…": "src/services/workspace-provider.ts",
  "La VM de editores no respondio a tiempo. Intenta de nuevo en un momento.": "src/services/workspace-provider.ts",
  "El tutor no esta disponible en este momento: el servidor del modelo no respondio.": "src/services/suggestion-policy.ts",
  "Ya usaste las <N> ayudas con codigo que tu docente permite para este archivo. Intenta el siguiente paso por tu cuenta.": "src/services/suggestion-policy.ts",
  "Ya usaste las <N> ayudas con codigo…": "src/services/suggestion-policy.ts",
  "El cambio tiene <N> lineas y tu docente permite aplicar como maximo <M>. Aplica una parte y escribe el resto tu.": "src/services/suggestion-policy.ts",
  "En este bloque del piloto trabajas sin el tutor. Sigue con tu ejercicio como lo harias en clase; el tutor vuelve en el siguiente bloque.": "src/services/pilot.ts",
  "Ya alcanzaste el limite de pistas definido por el docente para este ejercicio (<N>).": "src/services/decision-engine.ts",
  "Motivo de control": "src/services/decision-engine.ts",
  "codigo omitido: en esta etapa la ayuda es solo una pista": "src/services/intervention-templates.ts",
  "Tu respuesta quedo guardada. No pude calificarla ahora; tu docente podra revisarla.": "src/services/quiz.ts",
  // Avisos al docente (message de POST /api/quiz/launches y de PUT /api/pilot/block) que el
  // overlay pone en la linea de estado.
  "Quiz lanzado. Se activo …": "src/routes/quiz-routes.ts",
  "Grupos A y B asignados automaticamente al iniciar el bloque (<N> estudiantes; semilla: <semilla>).": "src/routes/pilot-routes.ts",
  "La cuenta de Google no pertenece al dominio permitido.": "src/services/google-auth.ts",
  // Valor de la politica sembrada del piloto (se ve en el campo «Nota docente»).
  "Prioriza pistas graduales, preguntas orientadoras y trazabilidad para el piloto.": "src/db/seeds.ts",
};

const TEXTOS_EXTERNOS: Record<string, string> = {
  "Authorized OAuth Apps": "GitHub, Settings > Applications (en ingles; nombre por verificar en la validacion).",
  "Installed GitHub Apps": "GitHub, Settings > Applications (en ingles; nombre por verificar en la validacion).",
  "Configure": "GitHub, boton de la GitHub App instalada (en ingles).",
  "Este Firefox": "Firefox, pagina about:debugging (por verificar).",
  "Cargar complemento temporal…": "Firefox, pagina about:debugging (por verificar).",
  "Output": "VS Code, panel de salida (en un VS Code en espanol se llama Salida).",
  "Extraer todo…": "Windows, menu contextual del Explorador sobre un .zip (por verificar en la validacion).",
};

// Textos de Chrome, macOS y VS Code que la guia cita tal como los copia /empezar.
const TEXTOS_EXTERNOS_COPIADOS_EN_EMPEZAR = [
  "Modo de desarrollador",
  "Cargar descomprimida",
  "Cargar extension sin empaquetar",
  "Ajustes del Sistema",
  "Privacidad y seguridad",
  "Abrir igualmente",
  "Instalar desde VSIX",
];
const PAGINA_EMPEZAR = path.join("src", "routes", "start-page-routes.ts");

function listarArchivos(carpeta: string, acepta: (ruta: string) => boolean, excluir: Set<string> = new Set()): string[] {
  const salida: string[] = [];
  for (const entrada of fs.readdirSync(carpeta, { withFileTypes: true })) {
    const ruta = path.join(carpeta, entrada.name);
    if (entrada.isDirectory()) {
      if (!excluir.has(entrada.name) && entrada.name !== "node_modules") {
        salida.push(...listarArchivos(ruta, acepta, excluir));
      }
    } else if (acepta(ruta)) {
      salida.push(ruta);
    }
  }
  return salida;
}

// El codigo guarda los textos como literales JS/TS/JSON o como HTML: se quitan los
// escapes y las entidades que la guia escribe como caracteres.
function normalizarCodigo(texto: string) {
  return texto
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/&times;/g, "×")
    .replace(/&minus;/g, "−")
    .replace(/&rarr;/g, "→")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function leer(ruta: string) {
  return normalizarCodigo(fs.readFileSync(ruta, "utf8"));
}

function corpusDeLaInterfaz() {
  const navegador = listarArchivos(
    path.join(RAIZ, "browser-ext-prod"),
    (ruta) => /\.(js|html|json)$/.test(ruta),
    new Set(["popup"]),
  );
  const vscode = listarArchivos(
    path.join(RAIZ, "vscode-ext-prod", "src"),
    (ruta) => ruta.endsWith(".ts") && !ruta.endsWith(".test.ts"),
    new Set(["test", "unit-tests"]),
  );
  const archivos = [
    ...navegador,
    ...vscode,
    path.join(RAIZ, "vscode-ext-prod", "package.json"),
    path.join(RAIZ, PAGINA_EMPEZAR),
  ];
  return archivos.map(leer);
}

/** Tramos fijos de un texto de la guia: sin las partes variables (<...>) ni los recortes (…). */
export function tramosFijos(texto: string) {
  return texto
    .split(/<[^<>]+>|…/)
    .map((tramo) => tramo.trim())
    .filter((tramo) => tramo.length > 0);
}

export function textosDeInterfaz(markdown: string) {
  return [...new Set([...markdown.matchAll(/«([^«»\n]+)»/g)].map((match) => match[1]))];
}

/** Todos los tramos fijos, en orden, dentro de un mismo archivo. */
export function aparece(texto: string, fuentes: string[]) {
  const tramos = tramosFijos(texto);
  if (!tramos.length) return false;
  return fuentes.some((fuente) => {
    let desde = 0;
    for (const tramo of tramos) {
      const donde = fuente.indexOf(tramo, desde);
      if (donde < 0) return false;
      desde = donde + tramo.length;
    }
    return true;
  });
}

test("guia de instalacion: los tramos fijos se separan de las partes variables", () => {
  assert.deepEqual(tramosFijos("ADACEEN: <tu nombre>"), ["ADACEEN:"]);
  assert.deepEqual(tramosFijos("Autoriza tu editor: codigo …"), ["Autoriza tu editor: codigo"]);
  assert.deepEqual(tramosFijos("El cambio tiene <N> lineas y tu docente permite aplicar como maximo <M>."), [
    "El cambio tiene",
    "lineas y tu docente permite aplicar como maximo",
    ".",
  ]);
  assert.equal(aparece("Hola <nombre>, adios", ["x = `Hola ${n}, adios`"]), true);
  assert.equal(aparece("Hola <nombre>, adios", ["adios", "Hola"]), false, "tramos en archivos distintos");
  assert.equal(aparece("Hola <nombre>, adios", ["`, adios` + `Hola`"]), false, "tramos fuera de orden");
  assert.deepEqual(textosDeInterfaz("Pulsa «Empezar» y «Salir».\n«Empezar» otra vez; «sin\ncerrar»"), ["Empezar", "Salir"]);
});

test("guia de instalacion: cada texto entre «» existe en el codigo que lo muestra", () => {
  const guia = fs.readFileSync(path.join(RAIZ, GUIA), "utf8");
  const textos = textosDeInterfaz(guia);
  // Una guia sin textos citados no probaria nada (por ejemplo, si cambian las comillas).
  assert.ok(textos.length >= 150, `la guia cita solo ${textos.length} textos entre «»`);
  const fuentes = corpusDeLaInterfaz();
  assert.ok(fuentes.length > 40, "no se encontraron los fuentes de las extensiones (¿falta el submodulo vscode-ext-prod?)");

  const faltan: string[] = [];
  for (const texto of textos) {
    if (texto in TEXTOS_EXTERNOS) continue;
    const archivoServidor = TEXTOS_DEL_SERVIDOR[texto];
    if (archivoServidor) {
      if (!aparece(texto, [leer(path.join(RAIZ, archivoServidor))])) {
        faltan.push(`«${texto}» (se esperaba en ${archivoServidor})`);
      }
      continue;
    }
    if (!aparece(texto, fuentes)) faltan.push(`«${texto}»`);
  }
  assert.deepEqual(faltan, [], `Textos de la guia que no estan en el codigo:\n${faltan.join("\n")}`);
});

test("guia de instalacion: las excepciones estan en uso y no sobran", () => {
  const guia = fs.readFileSync(path.join(RAIZ, GUIA), "utf8");
  const textos = new Set(textosDeInterfaz(guia));
  const fuentes = corpusDeLaInterfaz();
  for (const texto of [...Object.keys(TEXTOS_EXTERNOS), ...Object.keys(TEXTOS_DEL_SERVIDOR)]) {
    assert.ok(textos.has(texto), `excepcion que la guia ya no cita: «${texto}»`);
  }
  for (const texto of Object.keys(TEXTOS_DEL_SERVIDOR)) {
    assert.ok(!aparece(texto, fuentes), `«${texto}» ya esta en el codigo de las extensiones: sobra la excepcion`);
  }
  for (const [texto, motivo] of Object.entries(TEXTOS_EXTERNOS)) {
    assert.ok(motivo.length > 10, `la excepcion «${texto}» necesita un motivo`);
  }
  const empezar = leer(path.join(RAIZ, PAGINA_EMPEZAR));
  for (const texto of TEXTOS_EXTERNOS_COPIADOS_EN_EMPEZAR) {
    assert.ok(textos.has(texto), `texto externo copiado que la guia ya no cita: «${texto}»`);
    assert.ok(aparece(texto, [empezar]), `«${texto}» ya no esta en la copia de /empezar (${PAGINA_EMPEZAR})`);
  }
});

test("guia de instalacion: las versiones de la guia son las del codigo", () => {
  const guia = fs.readFileSync(path.join(RAIZ, GUIA), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(RAIZ, "browser-ext-prod", "manifest.json"), "utf8"));
  const vscode = JSON.parse(fs.readFileSync(path.join(RAIZ, "vscode-ext-prod", "package.json"), "utf8"));
  const introduccion = guia.split("\n## ")[0];
  assert.ok(introduccion.includes(`extensión de navegador ${manifest.version}`), `la guia no dice la version ${manifest.version} del navegador`);
  assert.ok(introduccion.includes(`extensión de VS Code ${vscode.version}`), `la guia no dice la version ${vscode.version} de VS Code`);
  assert.ok(guia.includes(`VS Code ${String(vscode.engines?.vscode || "").replace(/^\^/, "").replace(/\.0$/, "")} o posterior`), "la guia no dice la version minima de VS Code");
});
