// Google Cloud: cliente minimo de Compute Engine (leer el estado de una VM y encenderla) y sus errores de capacidad.
import { trimText } from "../shared/text-utils.js";
import type { FetchLike } from "../workspace/workspace-config.js";

async function readJson(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- cliente de Compute

export type ComputeInstanceRef = { project: string; zone: string; name: string };

export type ComputeReadResult =
  | { ok: true; vmStatus: string }
  | { ok: false; reason: string };

export type ComputeStartResult =
  | { accepted: true }
  | { accepted: false; reason: string; capacity: boolean };

export type ComputeClientDeps = {
  getAccessToken: () => Promise<string>;
  fetch?: FetchLike;
  computeBaseUrl?: string;
  timeoutMs?: number;
};

// Motivos por los que un instances.start no enciende y vale probar otra VM:
// sin cupo en la zona (stockout) o sin cuota (GPUS_ALL_REGIONS es 1 en el piloto).
const CAPACITY_RE = /ZONE_RESOURCE_POOL_EXHAUSTED|QUOTA_EXCEEDED|quotaExceeded|RESOURCE_EXHAUSTED|STOCKOUT|does not have enough resources|resourceNotAvailable|Quota .* exceeded|GPUS_ALL_REGIONS/i;

/** Texto corto del error que devuelve la API de Compute (codigos y mensaje, sin tokens). */
export function describeComputeError(json: Record<string, unknown>) {
  const error = json?.error;
  if (!error || typeof error !== "object") return "";
  const details = error as { message?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (Array.isArray(details.errors)) {
    for (const item of details.errors) {
      const reason = trimText((item as { reason?: unknown })?.reason);
      if (reason && !parts.includes(reason)) parts.push(reason);
    }
  }
  const message = trimText(details.message).replace(/\s+/g, " ").slice(0, 240);
  if (message) parts.push(message);
  return parts.join(": ");
}

export function isCapacityProblem(text: string) {
  return CAPACITY_RE.test(text);
}

export function reasonOf(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError" ? "timeout de la API de Compute" : String(error).slice(0, 200);
}

/**
 * Llamadas minimas a la API de Compute Engine (instances.get e instances.start).
 * Nunca lanza: red, timeout o token fallido salen como motivo.
 */
export function createComputeClient(deps: ComputeClientDeps) {
  const fetchImpl: FetchLike = deps.fetch || ((url, init) => fetch(url, init));
  const computeBaseUrl = (deps.computeBaseUrl || "https://compute.googleapis.com/compute/v1").replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? 10_000;

  function instanceUrl(ref: ComputeInstanceRef) {
    return `${computeBaseUrl}/projects/${encodeURIComponent(ref.project)}/zones/${encodeURIComponent(ref.zone)}/instances/${encodeURIComponent(ref.name)}`;
  }

  async function call(method: "GET" | "POST", url: string) {
    const token = await deps.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: controller.signal,
      });
      return { status: response.status, json: await readJson(response) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getStatus(ref: ComputeInstanceRef): Promise<ComputeReadResult> {
    try {
      const instance = await call("GET", instanceUrl(ref));
      if (instance.status < 200 || instance.status >= 300) {
        return { ok: false, reason: `instances.get HTTP ${instance.status}` };
      }
      return { ok: true, vmStatus: trimText(instance.json.status).toUpperCase() || "DESCONOCIDO" };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }

  async function start(ref: ComputeInstanceRef): Promise<ComputeStartResult> {
    try {
      const started = await call("POST", `${instanceUrl(ref)}/start`);
      if (started.status >= 200 && started.status < 300) return { accepted: true };
      const detail = describeComputeError(started.json);
      const reason = `instances.start HTTP ${started.status}${detail ? ` (${detail})` : ""}`;
      return { accepted: false, reason, capacity: isCapacityProblem(detail) };
    } catch (error) {
      return { accepted: false, reason: reasonOf(error), capacity: false };
    }
  }

  return { getStatus, start, instanceUrl };
}

export type ComputeClient = ReturnType<typeof createComputeClient>;
