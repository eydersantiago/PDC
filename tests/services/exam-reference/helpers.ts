import { gzipSync } from "node:zlib";
import { env } from "../../../src/config/env.js";
import type { AppSession } from "../../../src/types/app.js";
import type { ExamReference } from "../../../src/services/exam/exam-reference.js";

/**
 * Referencia privada del examen del 28-10-2026 (exam-reference.ts). La solucion real NO esta en
 * el repositorio (es publico): llega por EXAM_REFERENCE_B64. Aqui se usa una referencia de juguete
 * con la misma forma.
 */

export const FAKE: ExamReference = {
  version: 1,
  examen: "prueba",
  repo: "eydersantiago/sistema-bancario-fpoo",
  plan: "Plan: 1. Cliente 2. Cuenta",
  errores: "Errores: falta ; al final de la clase",
  pasos: [
    { id: "cliente", titulo: "Paso 1 - Cliente", archivos: ["src/modelo/Cliente.h", "src/modelo/Cliente.cpp"], apoyo: [], guia: "GUIA-CLIENTE", patrones: [] },
    { id: "cuenta", titulo: "Paso 2 - Cuenta", archivos: ["src/modelo/Cuenta.h", "src/modelo/Cuenta.cpp"], apoyo: [], guia: "GUIA-CUENTA", patrones: [] },
    { id: "cuentacorriente", titulo: "Paso 4 - CuentaCorriente", archivos: ["src/modelo/CuentaCorriente.h", "src/modelo/CuentaCorriente.cpp"], apoyo: ["src/modelo/Cuenta.h"], guia: "GUIA-CORRIENTE", patrones: ["corriente"] },
    { id: "main", titulo: "Paso 7 - main", archivos: ["src/main.cpp"], apoyo: [], guia: "GUIA-MAIN", patrones: [] },
  ],
  archivos: {
    "src/modelo/Cliente.h": "class Cliente {\n  // comentario\n  string nombre;\n};",
    "src/modelo/Cliente.cpp": "IMPL-CLIENTE-CPP",
    "src/modelo/Cuenta.h": "class Cuenta {\n  long saldo;\n  virtual bool retirarDinero(long cantidad);\n};",
    "src/modelo/Cuenta.cpp": "IMPL-CUENTA-CPP",
    "src/modelo/CuentaCorriente.h": "class CuentaCorriente : public Cuenta {};",
    "src/modelo/CuentaCorriente.cpp": "IMPL-CORRIENTE-CPP",
    "src/main.cpp": "IMPL-MAIN",
  },
};

export function encode(value: unknown) {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");
}

/** EXAM_REFERENCE_B64 y EXAM_REFERENCE llegan por config/env.ts: la prueba cambia esos campos. */
export function withEnv<T>(values: { b64?: string; mode?: string }, run: () => T): T {
  const previous = { b64: env.examReferenceB64, mode: env.examReferenceSwitch };
  env.examReferenceB64 = values.b64 ?? "";
  env.examReferenceSwitch = values.mode ?? "";
  try {
    return run();
  } finally {
    env.examReferenceB64 = previous.b64;
    env.examReferenceSwitch = previous.mode;
  }
}

/** La evidencia que pide la puerta: una sesion y la decision (no bloqueada) de la politica. */
const SESSION = { user: { id: "user-student-demo", role: "student" } } as unknown as Pick<AppSession, "user">;
export const ACCESS = { channel: "editor" as const, session: SESSION, decision: { blocked: false } };
