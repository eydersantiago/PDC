import assert from "node:assert/strict";
import test from "node:test";
import { createReferenceLineCheck } from "../../src/services/exam-reference.js";
import { createLiveProseTracker, createProseThrottle, liveProseFromModelText, looksLikeCodeLine } from "../../src/services/live-prose.js";

// Prosa en vivo de /suggest-tab (01-11-2026): «texto en vivo, codigo al final». Nada de codigo,
// ni la linea «Aplicar:», ni lineas de la referencia del examen.

const ANSWER = [
  "1) Resumen:",
  "- El estudiante declara la clase `Cuenta` y le falta el metodo para depositar.",
  "",
  "2) Sugerencias del codigo:",
  "- Agrega un metodo que reciba el monto y lo sume al saldo.",
  "- Valida que el monto sea positivo.",
  "",
  "3) Sugerencias del archivo:",
  "- Separa la declaracion (.h) de la implementacion (.cpp).",
  "",
  "4) Accion:",
  "Aplicar: insert",
  "```cpp",
  "void depositar(double monto) {",
  "    saldo += monto;",
  "}",
  "```",
  "",
  "6) Riesgos:",
  "- Compila despues de cada cambio.",
  "",
].join("\n");

test("prosa en vivo: lineas completas, sin «Aplicar:» ni el encabezado de la accion, y nada desde la primera valla", () => {
  const prose = liveProseFromModelText(ANSWER);
  assert.match(prose, /^1\) Resumen:/);
  assert.match(prose, /Valida que el monto sea positivo\./);
  assert.match(prose, /Separa la declaracion/);
  assert.doesNotMatch(prose, /Aplicar/i);
  assert.doesNotMatch(prose, /Accion/i);
  assert.equal(liveProseFromModelText("- Uno.\n4) Accion: `insert`\n**Accion:** replace\n- Dos.\n"), "- Uno.\n- Dos.");
  assert.doesNotMatch(prose, /```|depositar\(double|saldo \+=/);
  assert.doesNotMatch(prose, /Riesgos/, "lo de despues del bloque sale en el final");
});

test("prosa en vivo: solo hasta el ultimo salto de linea; una valla a medio escribir no se muestra", () => {
  assert.equal(liveProseFromModelText("1) Resumen:\n- Falta algo"), "1) Resumen:");
  assert.equal(liveProseFromModelText("- Primera linea completa.\n``"), "- Primera linea completa.");
  assert.equal(liveProseFromModelText("Sin salto todavia"), "");
  // Valla a mitad de linea (el modelo la pega a la frase): se corta ahi.
  assert.equal(liveProseFromModelText("- Usa esto: ```cpp\nint x = 0;\n```\n- Despues\n"), "");
  assert.equal(liveProseFromModelText("- Uno.\n~~~\ncodigo();\n~~~\n"), "- Uno.");
});

test("prosa en vivo: cada texto mas largo extiende al anterior (nada de lo leido desaparece)", () => {
  let previous = "";
  for (let end = 1; end <= ANSWER.length; end += 7) {
    const prose = liveProseFromModelText(ANSWER.slice(0, end));
    assert.ok(prose.startsWith(previous), `retrocedio en ${end}`);
    assert.doesNotMatch(prose, /```|saldo \+=|Aplicar/);
    previous = prose;
  }
});

test("prosa en vivo: codigo escrito sin valla tampoco sale", () => {
  const text = ["- Mira esta linea:", "    saldo += monto;", "int main() {", "#include <iostream>", "- Luego prueba con `cout << saldo;` en main.", ""].join("\n");
  const prose = liveProseFromModelText(text);
  assert.equal(prose, ["- Mira esta linea:", "- Luego prueba con `cout << saldo;` en main."].join("\n"));
  assert.equal(looksLikeCodeLine("}"), true);
  assert.equal(looksLikeCodeLine("for i in range(3):"), true, "Python sin valla");
  assert.equal(looksLikeCodeLine("    print(i)"), true, "sangria de bloque de codigo");
  assert.equal(looksLikeCodeLine("    - un punto anidado"), false, "una lista anidada es prosa");
  assert.equal(looksLikeCodeLine("- Si el monto es mayor, devuelve false:"), false);
  assert.equal(looksLikeCodeLine("- Usa `x;` aqui."), false, "codigo corto entre comillas en una frase: sigue siendo prosa");
});

test("prosa en vivo: sin caracteres chinos, como la respuesta final", () => {
  assert.equal(liveProseFromModelText("- Revisa el 循环 bucle for.\n"), "- Revisa el bucle for.");
});

test("prosa en vivo con la referencia del examen: ninguna linea copiada de ella, ni dentro de comillas ni en medio de la frase", () => {
  const reference = [
    "## src/Cuenta.cpp",
    "void Cuenta::depositar(double monto) { if (monto > 0) saldo += monto; }",
    "bool Cuenta::retirar(double monto) {",
    "    if (monto > saldo) return false;",
    "}",
  ].join("\n");
  const isReferenceLine = createReferenceLineCheck(reference);
  const text = [
    "1) Resumen:",
    "- Te falta el metodo de retiro.",
    "- if (monto > saldo) return false;",
    "- Copia `if (monto > saldo) return false;` al comienzo.",
    "- La condicion es if (monto > saldo) return false; y luego restas.",
    "- Sin el punto y coma: if (monto > saldo) return false",
    "- O la firma bool Cuenta::retirar(double monto) sin la llave",
    "- Empieza con if (monto > saldo) y despues decide.",
    "- Piensa que pasa si el monto supera el saldo (sin escribir la linea).",
    "",
  ].join("\n");
  const prose = liveProseFromModelText(text, { isReferenceLine });
  assert.equal(prose, ["1) Resumen:", "- Te falta el metodo de retiro.", "- Piensa que pasa si el monto supera el saldo (sin escribir la linea)."].join("\n"));
  for (const line of reference.split("\n").slice(1)) {
    assert.ok(!prose.includes(line.trim()), line);
  }
  // La prosa que nombra lo mismo con palabras si sale.
  assert.match(liveProseFromModelText("- La condicion compara el monto con el saldo.\n", { isReferenceLine }), /compara el monto/);
  assert.match(liveProseFromModelText("- Revisa el metodo retirar de la clase Cuenta.\n", { isReferenceLine }), /metodo retirar/);
});

test("tracker: solo avisa cuando la prosa cambia; reset empieza de cero (reintento)", () => {
  const tracker = createLiveProseTracker();
  assert.equal(tracker.update("1) Resumen:"), null, "sin linea completa");
  assert.equal(tracker.update("1) Resumen:\n"), "1) Resumen:");
  assert.equal(tracker.update("1) Resumen:\n- a"), null, "la linea a medias no cambia nada");
  assert.equal(tracker.update("1) Resumen:\n- abc\n"), "1) Resumen:\n- abc");
  tracker.reset();
  assert.equal(tracker.current, "");
  assert.equal(tracker.update("1) Resumen:\n"), "1) Resumen:");
});

test("throttle de la prosa: la primera enseguida, despues la ultima cada intervalo; cancel no deja nada", () => {
  let nowMs = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let id = 0;
  const emitted: string[] = [];
  const throttle = createProseThrottle({
    intervalMs: 300,
    emit: (text) => emitted.push(text),
    now: () => nowMs,
    setTimer: (callback, ms) => {
      id += 1;
      timers.set(id, { at: nowMs + ms, callback });
      return id;
    },
    clearTimer: (handle) => { timers.delete(handle as number); },
  });
  const advance = (ms: number) => {
    nowMs += ms;
    for (const [key, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= nowMs) {
        timers.delete(key);
        timer.callback();
      }
    }
  };
  throttle.push("a");
  throttle.push("ab");
  throttle.push("abc");
  assert.deepEqual(emitted, ["a"]);
  advance(299);
  assert.deepEqual(emitted, ["a"]);
  advance(1);
  assert.deepEqual(emitted, ["a", "abc"]);
  throttle.push("abcd");
  throttle.cancel();
  advance(1000);
  assert.deepEqual(emitted, ["a", "abc"]);
  assert.equal(timers.size, 0);
  throttle.push("z");
  advance(300);
  throttle.push("zz");
  throttle.flush();
  assert.deepEqual(emitted, ["a", "abc", "z", "zz"]);
});
