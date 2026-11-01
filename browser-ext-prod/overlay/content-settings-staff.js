// ADACEEN | Capa 4 - UI: tuerca, secciones del administrador y el docente: entorno de los estudiantes (0.7.19)
// y clase (0.7.21). Movido sin cambios de content-settings.js.

// ---- Entorno de los estudiantes (0.7.19, administrador o docente) ----
// Donde abren su editor: editor en la nube (tunel de VS Code), Codespaces o lo que diga
// ADACEEN_WORKSPACE_PROVIDER. Es uno solo para todo el piloto. El backend lo guarda y manda sobre
// la variable; se aplica con «Guardar cambios», como el resto de la tuerca.

// true desde que se pidio el entorno al abrir la tuerca hasta que se cierra.
let workspaceProviderSettingRequestedOnOpen = false;

const WORKSPACE_PROVIDER_LABELS = {
  tunnel: "Editor en la nube (túnel)",
  codespaces: "GitHub Codespaces",
};

function workspaceProviderLabel(provider) {
  return WORKSPACE_PROVIDER_LABELS[toText(provider)] || "Sin datos";
}

function formatWorkspaceProviderDate(value) {
  const date = new Date(toText(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function describeWorkspaceAgent(setting) {
  if (!setting) return "Sin datos";
  if (!setting.agentConfigured) return "Sin configurar";
  if (setting.agentOnline === true) return "Conectada";
  if (setting.agentOnline === false) return setting.vmAutostart ? "Apagada (se enciende sola)" : "Apagada";
  return "Configurada";
}

function describeWorkspaceProviderChange(setting) {
  if (!setting) return "Sin datos";
  if (!toText(setting.updatedAt)) return "Nunca: manda el servidor";
  return [formatWorkspaceProviderDate(setting.updatedAt), toText(setting.updatedBy)].filter(Boolean).join(" · ");
}

// Nota bajo el selector: el error, lo que falta para usar el editor en la nube o como se aplica.
function describeWorkspaceProviderNote(setting) {
  if (overlayState.workspaceProviderSettingError) {
    return { text: overlayState.workspaceProviderSettingError, warning: true };
  }
  if (!setting) {
    return { text: overlayState.workspaceProviderSettingBusy ? "Consultando el entorno de los estudiantes..." : "", warning: false };
  }
  if (!setting.agentConfigured) {
    return {
      text: "Para elegir el editor en la nube falta conectar la VM de editores una vez: bash deploy/produccion.sh aplicar en Cloud Shell.",
      warning: true,
    };
  }
  if (setting.provider === "tunnel" && setting.agentOnline === false && !setting.vmAutostart) {
    return { text: "La VM de editores está apagada: enciéndela antes de la clase con bash deploy/clase.sh iniciar.", warning: true };
  }
  return { text: "Se aplica con «Guardar cambios». Los estudiantes lo ven al recargar la página o en unos minutos.", warning: false };
}

function syncWorkspaceProviderSection() {
  const section = overlayEls?.settingsSectionWorkspace;
  if (!section) return;
  section.hidden = !canChooseWorkspaceProvider();
  if (section.hidden) return;

  const setting = overlayState.workspaceProviderSetting;
  const select = overlayEls.workspaceProviderSelect;
  if (select) {
    // Solo cuando cambia lo que dice el backend: lo elegido y sin guardar no se pisa en cada render.
    if (renderKeyChanged(select, JSON.stringify([!!setting, setting?.choice || "server", toText(setting?.updatedAt)]))) {
      select.value = setting?.choice || "server";
    }
    select.disabled = !setting || !!overlayState.workspaceProviderSettingBusy;
  }
  if (overlayEls.workspaceProviderTunnelOption) {
    // Sin el agente de la VM el editor en la nube no puede prepararse (el backend responde 409).
    overlayEls.workspaceProviderTunnelOption.disabled = !!setting && !setting.agentConfigured && setting.choice !== "tunnel";
  }
  setTextIfChanged(
    overlayEls.workspaceProviderServerOption,
    setting ? `Lo que diga el servidor (${workspaceProviderLabel(setting.serverProvider)})` : "Lo que diga el servidor",
  );
  setTextIfChanged(
    overlayEls.workspaceProviderActiveValue,
    setting
      ? `${workspaceProviderLabel(setting.provider)} · ${setting.source === "extension" ? "elegido aquí" : "del servidor"}`
      : "Sin datos",
  );
  setTextIfChanged(overlayEls.workspaceAgentValue, describeWorkspaceAgent(setting));
  setTextIfChanged(overlayEls.workspaceProviderServerValue, setting ? `ADACEEN_WORKSPACE_PROVIDER = ${toText(setting.serverProvider)}` : "Sin datos");
  setTextIfChanged(overlayEls.workspaceProviderUpdatedValue, describeWorkspaceProviderChange(setting));
  const note = describeWorkspaceProviderNote(setting);
  setTextIfChanged(overlayEls.workspaceProviderNote, note.text);
  overlayEls.workspaceProviderNote?.classList?.toggle("is-warning", note.warning);
  setTextIfChanged(
    overlayEls.settingsSectionWorkspaceHint,
    setting ? `Ahora: ${workspaceProviderLabel(setting.provider)}` : "Editor en la nube o Codespaces",
  );
}

// ---- Clase (0.7.21, administrador o docente) ----
// «Iniciar clase» enciende la GPU y, con el editor en la nube, la VM de editores: lo que hace
// bash deploy/clase.sh iniciar, sin Cloud Shell. Las lineas «Editor en la nube» y «Modelo» salen
// de GET /api/admin/clase/estado (backend-admin.service.js), que tras pulsar se sondea cada 10 s.

// true desde que se pidio el estado al abrir la tuerca hasta que se cierra.
let classStatusRequestedOnOpen = false;

function describeClassEditor(status) {
  if (!status) return "Sin datos";
  if (!status.editorsNeeded) return status.provider === "codespaces" ? "No hace falta (Codespaces)" : "Sin VM configurada";
  if (status.workspaceAgentOnline === true) return "Conectada";
  const editors = status.editors;
  if (!editors) return "Sin datos";
  if (editors.state === "starting") return "Encendiendo…";
  if (editors.state === "running") return status.workspaceAgentOnline === null ? "Encendida" : "Encendida, el agente aún no se conecta";
  if (editors.state === "stopping") return "Apagándose";
  if (editors.state === "failed") return "No encendió";
  if (editors.state === "unknown") return "Sin datos";
  return "Apagada";
}

function describeClassModel(status) {
  if (!status) return "Sin datos";
  const alive = Number(status.modelWorkersAlive) || 0;
  if (alive >= 1) return `${alive} servidor(es) vivo(s)`;
  if (status.gpu === "starting") return "GPU encendiendo…";
  if (status.gpu === "running") return "GPU encendida, sin latido aún";
  if (status.gpu === "failed") return "GPU no encendió";
  if (status.gpu === "none") return "Sin GPU configurada ni servidores";
  return "Sin servidores; GPU apagada";
}

// Nota bajo las lineas: el error, el resultado de «Iniciar clase», lo que falla o que hace el boton.
function describeClassNote(status) {
  if (overlayState.classStatusError) return { text: overlayState.classStatusError, warning: true, ready: false };
  if (status?.ready) {
    return { text: overlayState.classStartMessage || "Todo listo para la clase.", warning: false, ready: true };
  }
  if (overlayState.classStartMessage) {
    const failed = /no encendi|no se pudo|no quedó|Pasaron/i.test(overlayState.classStartMessage);
    const waiting = overlayState.classStartPollUntil > 0 ? " Esperando a que todo quede listo…" : "";
    return { text: `${overlayState.classStartMessage}${failed ? "" : waiting}`, warning: failed, ready: false };
  }
  if (!status) {
    return { text: overlayState.classStatusBusy ? "Consultando el estado de la clase..." : "", warning: false, ready: false };
  }
  const failed = (Array.isArray(status.gpus) ? status.gpus : []).filter((gpu) => gpu?.state === "failed");
  if (failed.length) {
    return { text: `GPU que no encendió: ${failed.map((gpu) => `${gpu.name} (${toText(gpu.problem)})`).join("; ")}.`, warning: true, ready: false };
  }
  return {
    text: "«Iniciar clase» enciende la GPU y, con el editor en la nube, la VM de editores (2-5 min). No apaga nada: para apagar, bash deploy/clase.sh terminar.",
    warning: false,
    ready: false,
  };
}

function syncClassSection() {
  const section = overlayEls?.settingsSectionClass;
  if (!section) return;
  section.hidden = !canChooseWorkspaceProvider();
  if (section.hidden) return;

  const status = overlayState.classStatus;
  setTextIfChanged(overlayEls.classEditorValue, describeClassEditor(status));
  setTextIfChanged(overlayEls.classModelValue, describeClassModel(status));
  const note = describeClassNote(status);
  setTextIfChanged(overlayEls.classStartNote, note.text);
  overlayEls.classStartNote?.classList?.toggle("is-warning", note.warning);
  overlayEls.classStartNote?.classList?.toggle("is-ready", note.ready);
  if (overlayEls.classStartBtn) {
    // Con un backend anterior (404) no hay nada que pedir; mientras se enciende, tampoco.
    overlayEls.classStartBtn.disabled = !!overlayState.classStartBusy || (!status && !!overlayState.classStatusError);
  }
  if (overlayEls.classRefreshBtn) overlayEls.classRefreshBtn.disabled = !!overlayState.classStatusBusy;
  setTextIfChanged(
    overlayEls.settingsSectionClassHint,
    status ? (status.ready ? "Lista" : overlayState.classStartPollUntil > 0 ? "Encendiendo…" : "No está lista") : "Encender la GPU y el editor en la nube",
  );
}

// «Guardar cambios» del administrador o el docente: guarda el entorno solo si el selector cambio. Devuelve el
// mensaje para la linea de estado ("" si no habia nada que guardar).
async function saveWorkspaceProviderFromSettings() {
  const setting = overlayState.workspaceProviderSetting;
  const select = overlayEls?.workspaceProviderSelect;
  if (!canChooseWorkspaceProvider() || !select || !setting) return "";
  const current = setting.choice || "server";
  const requested = toText(select.value) || current;
  if (requested === current) return "";
  const result = await saveWorkspaceProviderSetting(requested);
  // Si no se guardo, el selector vuelve a lo que dice el backend.
  if (!result.ok) select.value = current;
  return result.message;
}
