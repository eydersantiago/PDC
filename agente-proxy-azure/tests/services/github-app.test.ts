import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodespaceQuickstartUrl,
  buildCodespaceWebUrlFromName,
  generateInstallStateToken,
} from "../../src/services/github-app.js";

test("buildCodespaceQuickstartUrl genera URL base para repositorio", () => {
  assert.equal(
    buildCodespaceQuickstartUrl({ repoFullName: "octo/demo" }),
    "https://codespaces.new/octo/demo?quickstart=1",
  );
});

test("buildCodespaceQuickstartUrl prioriza pull request sobre rama", () => {
  assert.equal(
    buildCodespaceQuickstartUrl({
      repoFullName: "https://github.com/Org/my-repo.git",
      pullNumber: 42,
      branchName: "feature/ignored",
    }),
    "https://codespaces.new/Org/my-repo/pull/42?quickstart=1",
  );
});

test("buildCodespaceQuickstartUrl codifica ramas con slash y espacios", () => {
  assert.equal(
    buildCodespaceQuickstartUrl({
      repoFullName: "octo/demo",
      branchName: "feature/test branch",
    }),
    "https://codespaces.new/octo/demo/tree/feature/test%20branch?quickstart=1",
  );
});

test("buildCodespaceQuickstartUrl rechaza nombres de repositorio invalidos", () => {
  assert.throws(
    () => buildCodespaceQuickstartUrl({ repoFullName: "solo-owner" }),
    /repoFullName invalido/,
  );
});

test("buildCodespaceWebUrlFromName arma URL github.dev solo cuando hay nombre", () => {
  assert.equal(buildCodespaceWebUrlFromName("  shiny-space  "), "https://shiny-space.github.dev");
  assert.equal(buildCodespaceWebUrlFromName(""), "");
  assert.equal(buildCodespaceWebUrlFromName(null), "");
});

test("generateInstallStateToken produce tokens hexadecimales de 40 caracteres", () => {
  const first = generateInstallStateToken();
  const second = generateInstallStateToken();

  assert.match(first, /^[a-f0-9]{40}$/);
  assert.match(second, /^[a-f0-9]{40}$/);
  assert.notEqual(first, second);
});
