import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { corsMode, DEFAULT_ALLOWED_ORIGINS, env, isOriginAllowed } from "../../src/config/env.js";

// A12.12 · ADACEEN-155, riesgo 5: sin ALLOWED_ORIGINS, CORS acepta solo los origenes de ADACEEN
// (antes aceptaba cualquiera con credenciales).

function withAllowedOrigins<T>(value: string[], run: () => T) {
  const saved = env.allowedOrigins;
  env.allowedOrigins = value;
  try {
    return run();
  } finally {
    env.allowedOrigins = saved;
  }
}

/** Origen de ejemplo para un patron de content_scripts: https://*.github.dev/* -> https://ejemplo.github.dev */
function sampleOrigin(pattern: string) {
  const match = pattern.match(/^(https?):\/\/([^/]+)\//);
  assert.ok(match, `patron inesperado: ${pattern}`);
  return `${match[1]}://${match[2].replace(/^\*\./, "ejemplo.")}`;
}

test("cors: la lista por defecto cubre todas las paginas donde corre la extension", () => {
  const manifest = JSON.parse(readFileSync(path.resolve(process.cwd(), "browser-ext-prod/manifest.json"), "utf8")) as {
    content_scripts: Array<{ matches: string[] }>;
  };
  const origins = new Set(manifest.content_scripts.flatMap((entry) => entry.matches).map(sampleOrigin));
  assert.ok(origins.size >= 5, "se leyeron los content_scripts");

  withAllowedOrigins([], () => {
    assert.equal(corsMode(), "default");
    for (const origin of origins) {
      assert.equal(isOriginAllowed(origin), true, `${origin} deberia estar permitido`);
    }
  });
});

test("cors: por defecto acepta la extension, el backend y localhost, y rechaza lo ajeno", () => {
  withAllowedOrigins([], () => {
    for (const origin of [
      "chrome-extension://gkkcnlcbdjdjcibkkbhpopichconbojg",
      "moz-extension://0f3c2a9e-5b7d-4e8a-9c1d-2f3a4b5c6d7e",
      "https://app-adaceen-api-eyder05232002.azurewebsites.net",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "https://campusvirtual.univalle.edu.co",
      "https://insiders.vscode.dev",
    ]) {
      assert.equal(isOriginAllowed(origin), true, origin);
    }
    for (const origin of [
      "https://sitio-ajeno.example",
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "https://github.com.sitio-ajeno.example",
      "http://localhost.sitio-ajeno.example",
      "https://vscode.dev.sitio-ajeno.example",
      "null",
    ]) {
      assert.equal(isOriginAllowed(origin), false, origin);
    }
    assert.equal(isOriginAllowed(undefined), true, "sin Origin (VS Code, servidor a servidor)");
  });
  assert.ok(DEFAULT_ALLOWED_ORIGINS.includes("chrome-extension://gkkcnlcbdjdjcibkkbhpopichconbojg"));
});

test("cors: ALLOWED_ORIGINS manda cuando esta definida, y * abre a todos", () => {
  withAllowedOrigins(["https://vscode.dev"], () => {
    assert.equal(corsMode(), "custom");
    assert.equal(isOriginAllowed("https://vscode.dev"), true);
    assert.equal(isOriginAllowed("https://github.com"), false);
  });
  withAllowedOrigins(["*"], () => {
    assert.equal(corsMode(), "open");
    assert.equal(isOriginAllowed("https://sitio-ajeno.example"), true);
  });
});
