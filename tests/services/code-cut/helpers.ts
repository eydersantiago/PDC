import assert from "node:assert/strict";
import { seedTeacherPolicy } from "../../../src/db/seeds.js";
import { evaluateSuggestionPolicy } from "../../../src/services/policy/suggestion-policy.js";
import type { TeacherPolicy } from "../../../src/types/app.js";

/**
 * Recorte del codigo del tutor sin «...» (30-10-2026, src/services/vscode/code-cut.ts). El caso real:
 * un estudiante selecciona `int main(){...}` (4 lineas), pide ayuda y el modelo escribe un main
 * de 14 lineas. Antes el guardarrail lo cortaba en 5 lineas, agregaba
 * «// ... recortado por la politica del docente: completa el resto tu» y quitaba «Aplicar:»;
 * VS Code leia esa linea como codigo resumido y escondia la sugerencia, y como no se podia
 * aplicar, la etapa no subia nunca. Codigo ficticio: nada de la solucion del taller.
 */

// --- Las reglas de VS Code 0.0.35 (suggestion-code.ts, isElisionLine), copiadas tal cual -----
const ELLIPSIS_ALONE = /^(?:\.{3,}|…)\s*(?:(?:\/\/|#|\/\*|<!--|--).*)?$/;
const COMMENTED_ELLIPSIS = /^(?:\/\/+|#+|\/\*+|<!--|--)\s*(?:\.{3,}|…)/;
const ELISION_PHRASE = /\b(?:resto|demas|demás)\b.*\b(?:codigo|código|metodo|método|clase|archivo|funcion|función|igual|bloque)\b|\b(?:sin cambios|igual que antes|se mantiene|codigo existente|código existente|existing code|rest of (?:the )?code|unchanged)\b/i;
const COMMENT_START = /^(?:\/\/+|#(?!\s*(?:include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma)\b)|\/\*+|<!--|--\s)/;

function extensionSeesElision(line: string) {
  const text = line.trim();
  if (!text) return false;
  if (ELLIPSIS_ALONE.test(text) || COMMENTED_ELLIPSIS.test(text)) return true;
  return COMMENT_START.test(text) && ELISION_PHRASE.test(text);
}

export function fences(markdown: string) {
  return [...markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)].map((match) => match[2].replace(/\n$/, ""));
}

/** Ningun bloque de la salida tiene una linea que VS Code tome por codigo resumido ni «...». */
export function assertNoElision(markdown: string, label = "") {
  for (const code of fences(markdown)) {
    for (const line of code.split("\n")) {
      assert.ok(!extensionSeesElision(line), `${label}: linea de resumen en el bloque: ${line}`);
      assert.ok(!/\.{3}|…/.test(line), `${label}: puntos suspensivos en el bloque: ${line}`);
      assert.ok(!/\bresto\b/i.test(line), `${label}: «resto» en el bloque: ${line}`);
    }
  }
}

export function policy(overrides: Partial<TeacherPolicy> = {}): TeacherPolicy {
  return {
    ...seedTeacherPolicy,
    eventRules: { ...seedTeacherPolicy.eventRules },
    codeApplication: { ...seedTeacherPolicy.codeApplication },
    updatedAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  } as TeacherPolicy;
}

export const MAIN_SELECTION = ["int main(){", "    cout << \"Hola\";", "    return 0;", "}"].join("\n");

export const MAIN_PROPOSED = [
  "int main() {",
  "    Persona persona(\"001\", \"Ana\");",
  "    Caja caja(1, 1000);",
  "    cout << \"Total inicial: \" << caja.getTotal() << endl;",
  "    if (caja.sacar(200)) {",
  "        cout << \"Listo\" << endl;",
  "    } else {",
  "        cout << \"No alcanza\" << endl;",
  "    }",
  "    caja.meter(500);",
  "    cout << \"Total final: \" << caja.getTotal() << endl;",
  "    cout << \"Hola\";",
  "    return 0;",
  "}",
].join("\n");

export function answer(code: string, applyLine = "Aplicar: replace", language = "cpp") {
  return [
    "1) Resumen:",
    "- El main todavia no usa las clases.",
    "",
    "4) Accion:",
    applyLine,
    `\`\`\`${language}`,
    code,
    "```",
    "",
    "5) Riesgos:",
    "- Compila despues de cada cambio.",
  ].filter((line) => line !== null).join("\n");
}

/** Decision del editor con el tope de la etapa: 0 aplicaciones y 0, 1 o 2 pedidos explicitos. */
export function editorDecision(explicitRequestsBefore: number, base = policy()) {
  return evaluateSuggestionPolicy({
    policy: base,
    signals: { tabContent: MAIN_SELECTION, selection: MAIN_SELECTION, languageHint: "cpp", filePath: "src/main.cpp", question: "Mejora el main." },
    applicationsUsed: 0,
    explicitRequestsBefore,
  });
}
