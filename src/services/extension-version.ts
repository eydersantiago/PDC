// Version de una extension de ADACEEN (navegador o VS Code): x, x.y, x.y.z o x.y.z.w, y su
// comparacion. Antes vivia en chrome-web-store.ts (que la reexporta) y tenia copias en
// download-versions.ts y vscode-presence.ts: un cambio pensado para la tienda cambiaba en
// silencio el estado de la extension de VS Code.

const EXTENSION_VERSION_RE = /^\d+(\.\d+){0,3}$/;

/** La version recortada, o "" si no tiene esa forma. */
export function cleanExtensionVersion(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return EXTENSION_VERSION_RE.test(text) ? text : "";
}

/** Negativo si `left` es anterior a `right`, 0 si son iguales (1.2 = 1.2.0) y positivo si es posterior. */
export function compareExtensionVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
