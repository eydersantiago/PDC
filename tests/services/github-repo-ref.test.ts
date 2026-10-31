import assert from "node:assert/strict";
import test from "node:test";
import {
  formatGithubRepoRef,
  normalizeGithubLogin,
  parseGithubRepoRef,
  sameGithubRepo,
} from "../../src/services/github-repo-ref.js";

/**
 * Un solo lector de repositorios de GitHub (src/services/github-repo-ref.ts, 30-10-2026) para el
 * tema del piloto, la referencia del examen y el avance de los talleres.
 */

test("repositorio de GitHub: cada forma en que llega", () => {
  const cases: Array<[string, { owner: string | null; name: string } | null]> = [
    ["sistema-bancario-fpoo", { owner: null, name: "sistema-bancario-fpoo" }],
    ["eydersantiago/sistema-bancario-fpoo", { owner: "eydersantiago", name: "sistema-bancario-fpoo" }],
    ["https://github.com/EyderSantiago/Sistema-Bancario-FPOO", { owner: "EyderSantiago", name: "Sistema-Bancario-FPOO" }],
    ["http://www.github.com/vbucheli/IMC.git", { owner: "vbucheli", name: "IMC" }],
    ["https://github.com/vbucheli/IMC/tree/main", { owner: "vbucheli", name: "IMC" }],
    ["https://github.com/vbucheli/IMC/tree/main/IMC-tests?tab=readme", { owner: "vbucheli", name: "IMC" }],
    ["https://github.com/vbucheli/IMC/blob/main/src/main.cpp#L10", { owner: "vbucheli", name: "IMC" }],
    ["github.com/vbucheli/Nutricion.git", { owner: "vbucheli", name: "Nutricion" }],
    ["git@github.com:vbucheli/IMC.git", { owner: "vbucheli", name: "IMC" }],
    ["  vbucheli / IMC ", { owner: "vbucheli", name: "IMC" }],
    ["sistema-bancario-fpoo.git", { owner: null, name: "sistema-bancario-fpoo" }],
    ["https://gitlab.com/vbucheli/IMC", null],
    ["gitlab.com/vbucheli/IMC", null],
    ["vscode://alumno/taller/src/main.cpp", null],
    ["https://github.com/vbucheli", null],
    ["../..", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parseGithubRepoRef(input), expected, input);
  }
  assert.equal(parseGithubRepoRef(undefined), null);
  assert.equal(formatGithubRepoRef({ owner: "vbucheli", name: "IMC" }), "vbucheli/IMC");
  assert.equal(formatGithubRepoRef({ owner: null, name: "IMC" }), "IMC");
});

test("repositorio de GitHub: el mismo, sin mayusculas; sin dueno compara solo el nombre", () => {
  const ref = (value: string) => parseGithubRepoRef(value);
  assert.equal(sameGithubRepo(ref("EyderSantiago/Sistema-Bancario-FPOO"), ref("https://github.com/eydersantiago/sistema-bancario-fpoo/tree/main")), true);
  assert.equal(sameGithubRepo(ref("otro/sistema-bancario-fpoo"), ref("eydersantiago/sistema-bancario-fpoo")), false, "dos duenos distintos");
  assert.equal(sameGithubRepo(ref("sistema-bancario-fpoo"), ref("eydersantiago/sistema-bancario-fpoo")), true, "sin dueno, por el nombre");
  assert.equal(sameGithubRepo(ref("a/uno"), ref("a/dos")), false);
  assert.equal(sameGithubRepo(null, ref("a/uno")), false);
});

test("login de GitHub: sin espacios y en minusculas", () => {
  assert.equal(normalizeGithubLogin("  Ana-GH "), "ana-gh");
  assert.equal(normalizeGithubLogin(null), "");
  assert.equal(normalizeGithubLogin(undefined), "");
});
