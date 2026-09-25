import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Lee las rutas registradas en src/routes/*.ts: app.get("..."), app.post([...]).
// Resuelve las constantes de texto del mismo archivo (const X = "...") y las
// plantillas simples (`${X}.json`).
async function routesInCode() {
  const dir = path.resolve(process.cwd(), "src/routes");
  const routes = new Set<string>();
  for (const file of await fsp.readdir(dir)) {
    if (!file.endsWith(".ts")) continue;
    const text = await fsp.readFile(path.join(dir, file), "utf8");
    const constants = new Map<string, string>();
    for (const match of text.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)) constants.set(match[1], match[2]);
    const resolve = (token: string) => {
      const clean = token.trim();
      if (!clean) return null;
      if (clean.startsWith("\"")) return clean.slice(1, -1);
      if (clean.startsWith("`")) {
        return clean.slice(1, -1).replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_all, name: string) => constants.get(name) ?? `\${${name}}`);
      }
      return constants.get(clean) ?? null;
    };
    for (const match of text.matchAll(/app\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|"[^"]+"|`[^`]+`)/g)) {
      const method = match[1].toUpperCase();
      const arg = match[2];
      const tokens = arg.startsWith("[") ? arg.slice(1, -1).split(",") : [arg];
      for (const token of tokens) {
        const route = resolve(token);
        if (route) routes.add(`${method} ${route}`);
      }
    }
  }
  return [...routes].sort();
}

test("contrato de la API: todas las rutas del backend estan documentadas", async () => {
  const doc = await fsp.readFile(path.resolve(process.cwd(), "docs/arquitectura/contrato-api.md"), "utf8");
  const routes = await routesInCode();
  assert.ok(routes.length >= 100, `se esperaban mas de 100 rutas y se leyeron ${routes.length}`);
  assert.ok(routes.includes("GET /privacy-policy.json"), "no se resolvio la ruta con plantilla");
  const missing = routes.filter((route) => !doc.includes(`\`${route}\``));
  assert.deepEqual(missing, [], `Faltan en docs/arquitectura/contrato-api.md: ${missing.join(", ")}`);
});
