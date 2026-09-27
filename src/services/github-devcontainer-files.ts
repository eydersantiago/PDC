// GitHub: contenido del devcontainer, de las extensiones recomendadas y del script de instalacion, y marcas para detectarlos.
// Movido sin cambios desde src/services/github-app.ts (solo se agrego "export" y los imports); src/services/github-app.ts lo reexporta.
import { ADACEEN_EXTENSION_ID, ADACEEN_INSTALL_SCRIPT_VERSION, FALLBACK_INSTALL_COMMAND, githubRequest, parseRepoFullName } from "./github-api.js";
import type { GithubPullRequestSummary, JsonObject } from "./github-api.js";
import { trimText, uniqueStrings } from "./text-utils.js";

export function isBootstrapPullRequestCandidate(pull: GithubPullRequestSummary) {
  const headRef = trimText(pull.head?.ref).toLowerCase();
  if (headRef.startsWith("adaceen/devcontainer-bootstrap-")) return true;

  const title = trimText(pull.title).toLowerCase();
  if (title.includes("bootstrap devcontainer") && title.includes("adaceen")) return true;

  const body = trimText(pull.body).toLowerCase();
  if (body.includes("generado automaticamente por adaceen")) return true;

  return false;
}

export function isUsableBootstrapPullRequest(pull: GithubPullRequestSummary) {
  const state = trimText(pull.state).toLowerCase();
  const mergedAt = trimText(pull.merged_at);
  return state === "open" || !!mergedAt;
}

export async function findLatestBootstrapPullRequest(input: {
  installationToken: string;
  repoFullName: string;
}) {
  const repo = parseRepoFullName(input.repoFullName);
  const pulls = await githubRequest<GithubPullRequestSummary[]>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?state=all&per_page=100&sort=updated&direction=desc`,
    { token: input.installationToken },
  );

  const items = Array.isArray(pulls) ? pulls : [];
  const match = items.find((item) => (
    isBootstrapPullRequestCandidate(item)
    && isUsableBootstrapPullRequest(item)
  ));
  if (!match) return null;

  const pullNumber = Number.isFinite(Number(match.number))
    ? Math.max(0, Number(match.number))
    : 0;

  return {
    pullNumber,
    pullUrl: trimText(match.html_url),
    state: trimText(match.state),
    mergedAt: trimText(match.merged_at),
    title: trimText(match.title),
    headRef: trimText(match.head?.ref),
  };
}

export function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as JsonObject) };
}

export function parseJsonObject(value: string): JsonObject | null {
  const clean = trimText(value);
  if (!clean) return null;

  try {
    const parsed = JSON.parse(clean);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

export function toStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => trimText(item)).filter(Boolean);
}

export function ensureLifecycleCommand(value: unknown, command: string): unknown {
  if (typeof value === "string") {
    const current = trimText(value);
    if (!current) return command;
    if (current.includes(command)) return current;
    return `${current} && ${command}`;
  }

  if (Array.isArray(value)) {
    const current = value.map((item) => trimText(item)).filter(Boolean);
    if (current.some((item) => item.includes(command))) {
      return current;
    }
    return [...current, command];
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    const alreadyIncluded = Object.values(output).some((item) => typeof item === "string" && item.includes(command));
    if (alreadyIncluded) {
      return output;
    }

    let key = "adaceenBootstrap";
    let counter = 1;
    while (Object.prototype.hasOwnProperty.call(output, key)) {
      counter += 1;
      key = `adaceenBootstrap${counter}`;
    }
    output[key] = command;
    return output;
  }

  return command;
}

export function defaultDevcontainerPayload() {
  return {
    name: "ADACEEN Devcontainer",
    image: "mcr.microsoft.com/devcontainers/universal:2",
    customizations: {
      vscode: {
        extensions: [
          ADACEEN_EXTENSION_ID,
          "ms-python.python",
          "ms-vscode.cpptools",
          "eamodio.gitlens",
        ],
        settings: {
          "editor.formatOnSave": true,
          "files.trimTrailingWhitespace": true,
        },
      },
    },
    extensions: [ADACEEN_EXTENSION_ID],
    postCreateCommand: FALLBACK_INSTALL_COMMAND,
    postAttachCommand: FALLBACK_INSTALL_COMMAND,
    updateContentCommand: FALLBACK_INSTALL_COMMAND,
  };
}

export function buildDevcontainerJson(rawJson: string) {
  const base = parseJsonObject(rawJson) || defaultDevcontainerPayload();
  const payload = asJsonObject(base);

  if (!trimText(payload.name)) {
    payload.name = "ADACEEN Devcontainer";
  }

  const hasBuild = payload.build != null;
  if (!trimText(payload.image) && !hasBuild) {
    payload.image = "mcr.microsoft.com/devcontainers/universal:2";
  }

  const customizations = asJsonObject(payload.customizations);
  const vscode = asJsonObject(customizations.vscode);
  vscode.extensions = uniqueStrings([
    ...toStringArray(vscode.extensions),
    ADACEEN_EXTENSION_ID,
  ]);

  const settings = asJsonObject(vscode.settings);
  if (settings["editor.formatOnSave"] == null) {
    settings["editor.formatOnSave"] = true;
  }
  if (settings["files.trimTrailingWhitespace"] == null) {
    settings["files.trimTrailingWhitespace"] = true;
  }
  vscode.settings = settings;
  customizations.vscode = vscode;
  payload.customizations = customizations;

  payload.extensions = uniqueStrings([
    ...toStringArray(payload.extensions),
    ADACEEN_EXTENSION_ID,
  ]);
  payload.postCreateCommand = ensureLifecycleCommand(payload.postCreateCommand, FALLBACK_INSTALL_COMMAND);
  payload.postAttachCommand = ensureLifecycleCommand(payload.postAttachCommand, FALLBACK_INSTALL_COMMAND);
  payload.updateContentCommand = ensureLifecycleCommand(payload.updateContentCommand, FALLBACK_INSTALL_COMMAND);

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function buildWorkspaceExtensionsJson(rawJson: string) {
  const payload = asJsonObject(parseJsonObject(rawJson) || {});
  payload.recommendations = uniqueStrings([
    ...toStringArray(payload.recommendations),
    ADACEEN_EXTENSION_ID,
  ]);

  const unwanted = toStringArray(payload.unwantedRecommendations)
    .filter((item) => item.toLowerCase() !== ADACEEN_EXTENSION_ID);
  if (unwanted.length > 0) {
    payload.unwantedRecommendations = uniqueStrings(unwanted);
  } else {
    delete payload.unwantedRecommendations;
  }

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function defaultInstallExtensionsScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `ADACEEN_INSTALL_SCRIPT_VERSION="${ADACEEN_INSTALL_SCRIPT_VERSION}"`,
    "ADACEEN_EXTENSION=\"adaceen.adaceen\"",
    "ADACEEN_VSIX_CANDIDATES=(",
    "  \"${ADACEEN_VSIX_PATH:-}\"",
    "  \".devcontainer/adaceen.vsix\"",
    "  \"adaceen.vsix\"",
    ")",
    "",
    "detect_code_cli() {",
    "  if command -v code >/dev/null 2>&1; then",
    "    echo \"code\"",
    "    return 0",
    "  fi",
    "  if command -v code-server >/dev/null 2>&1; then",
    "    echo \"code-server\"",
    "    return 0",
    "  fi",
    "  if command -v code-insiders >/dev/null 2>&1; then",
    "    echo \"code-insiders\"",
    "    return 0",
    "  fi",
    "  local vscode_bin",
    "  vscode_bin=\"$(find /vscode/bin -maxdepth 5 -type f -name code 2>/dev/null | head -n 1 || true)\"",
    "  if [ -n \"${vscode_bin}\" ]; then",
    "    echo \"${vscode_bin}\"",
    "    return 0",
    "  fi",
    "  return 1",
    "}",
    "",
    "if ! CODE_CLI=\"$(detect_code_cli)\"; then",
    "  echo \"[ADACEEN] VS Code CLI no disponible todavia. Se reintentara al adjuntar el Codespace.\"",
    "  exit 0",
    "fi",
    "",
    "for vsix in \"${ADACEEN_VSIX_CANDIDATES[@]}\"; do",
    "  if [ -n \"${vsix}\" ] && [ -f \"${vsix}\" ]; then",
    "    echo \"[ADACEEN] Instalando ADACEEN desde VSIX: ${vsix}\"",
    "    \"${CODE_CLI}\" --install-extension \"${vsix}\" --force || true",
    "    echo \"[ADACEEN] Instalacion completada.\"",
    "    exit 0",
    "  fi",
    "done",
    "",
    "latest_vsix=\"$(",
    "  find . .devcontainer -maxdepth 1 -type f -name 'adaceen-*.vsix' 2>/dev/null \\",
    "    | sort -V \\",
    "    | tail -n 1",
    ")\"",
    "if [ -n \"${latest_vsix}\" ] && [ -f \"${latest_vsix}\" ]; then",
    "  echo \"[ADACEEN] Instalando ultimo VSIX local: ${latest_vsix}\"",
    "  \"${CODE_CLI}\" --install-extension \"${latest_vsix}\" --force || true",
    "  echo \"[ADACEEN] Instalacion completada.\"",
    "  exit 0",
    "fi",
    "",
    "echo \"[ADACEEN] Instalando/actualizando ${ADACEEN_EXTENSION} desde Marketplace...\"",
    "\"${CODE_CLI}\" --install-extension \"${ADACEEN_EXTENSION}\" --force || true",
    "echo \"[ADACEEN] Instalacion completada.\"",
    "",
  ].join("\n");
}

export function buildInstallExtensionsScript(rawScript: string) {
  const current = rawScript.replace(/\r\n/g, "\n");
  if (!trimText(current)) {
    return defaultInstallExtensionsScript();
  }

  if (
    current.includes(ADACEEN_EXTENSION_ID)
    && current.includes("--install-extension")
    && !current.includes(`ADACEEN_INSTALL_SCRIPT_VERSION="${ADACEEN_INSTALL_SCRIPT_VERSION}"`)
  ) {
    return [
      defaultInstallExtensionsScript(),
      "",
      "# Script original conservado debajo; el bloque ADACEEN anterior fuerza la actualizacion primero.",
      current,
    ].join(current.endsWith("\n") ? "\n" : "\n") + (current.endsWith("\n") ? "" : "\n");
  }

  if (current.includes(ADACEEN_EXTENSION_ID) && current.includes("--install-extension")) {
    return current.endsWith("\n") ? current : `${current}\n`;
  }

  const addition = [
    "",
    "# ADACEEN fallback (agregado automaticamente)",
    "ADACEEN_EXTENSION=\"adaceen.adaceen\"",
    "ADACEEN_VSIX_CANDIDATES=(\"${ADACEEN_VSIX_PATH:-}\" \".devcontainer/adaceen.vsix\" \"adaceen.vsix\")",
    "ADACEEN_CODE_CLI=\"\"",
    "if command -v code >/dev/null 2>&1; then",
    "  ADACEEN_CODE_CLI=\"code\"",
    "elif command -v code-server >/dev/null 2>&1; then",
    "  ADACEEN_CODE_CLI=\"code-server\"",
    "elif command -v code-insiders >/dev/null 2>&1; then",
    "  ADACEEN_CODE_CLI=\"code-insiders\"",
    "fi",
    "if [ -n \"${ADACEEN_CODE_CLI}\" ]; then",
    "  ADACEEN_INSTALLED_FROM_VSIX=\"\"",
    "  for vsix in \"${ADACEEN_VSIX_CANDIDATES[@]}\"; do",
    "    if [ -n \"${vsix}\" ] && [ -f \"${vsix}\" ]; then",
    "      \"${ADACEEN_CODE_CLI}\" --install-extension \"${vsix}\" --force || true",
    "      ADACEEN_INSTALLED_FROM_VSIX=\"1\"",
    "      break",
    "    fi",
    "  done",
    "  if [ -z \"${ADACEEN_INSTALLED_FROM_VSIX}\" ]; then",
    "    ADACEEN_LATEST_VSIX=\"$(find . .devcontainer -maxdepth 1 -type f -name 'adaceen-*.vsix' 2>/dev/null | sort -V | tail -n 1)\"",
    "    if [ -n \"${ADACEEN_LATEST_VSIX}\" ] && [ -f \"${ADACEEN_LATEST_VSIX}\" ]; then",
    "      \"${ADACEEN_CODE_CLI}\" --install-extension \"${ADACEEN_LATEST_VSIX}\" --force || true",
    "    else",
    "      \"${ADACEEN_CODE_CLI}\" --install-extension \"${ADACEEN_EXTENSION}\" --force || true",
    "    fi",
    "  fi",
    "fi",
    "",
  ].join("\n");
  return `${current}${current.endsWith("\n") ? "" : "\n"}${addition}`;
}

export function detectDevcontainerBootstrapMarker(rawJson: string | null) {
  const text = trimText(rawJson);
  if (!text) return false;

  const parsed = parseJsonObject(text);
  if (!parsed) {
    return text.toLowerCase().includes(ADACEEN_EXTENSION_ID);
  }

  const payload = asJsonObject(parsed);
  const customizations = asJsonObject(payload.customizations);
  const vscode = asJsonObject(customizations.vscode);
  const vscodeExtensions = toStringArray(vscode.extensions).map((item) => item.toLowerCase());
  const rootExtensions = toStringArray(payload.extensions).map((item) => item.toLowerCase());
  const lifecycleFields = [payload.postCreateCommand, payload.postAttachCommand, payload.updateContentCommand]
    .map((value) => JSON.stringify(value || "").toLowerCase());

  return vscodeExtensions.includes(ADACEEN_EXTENSION_ID)
    || rootExtensions.includes(ADACEEN_EXTENSION_ID)
    || lifecycleFields.some((value) => value.includes("install-extensions.sh") || value.includes(ADACEEN_EXTENSION_ID));
}

export function detectWorkspaceExtensionsMarker(rawJson: string | null) {
  const text = trimText(rawJson);
  if (!text) return false;

  const parsed = parseJsonObject(text);
  if (!parsed) {
    return text.toLowerCase().includes(ADACEEN_EXTENSION_ID);
  }

  const payload = asJsonObject(parsed);
  const recommendations = toStringArray(payload.recommendations).map((item) => item.toLowerCase());
  return recommendations.includes(ADACEEN_EXTENSION_ID);
}

export function detectInstallScriptMarker(rawScript: string | null) {
  const text = trimText(rawScript).toLowerCase();
  if (!text) return false;
  return text.includes(ADACEEN_EXTENSION_ID) && text.includes("--install-extension");
}
