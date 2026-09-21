import os from "node:os";
import { env } from "../config/env.js";

/**
 * Identidad del worker que atendio un job.
 *
 * El id crudo lo pone cada maquina en QUEUE_WORKER_ID y viaja dentro del
 * mensaje de resultado (QueueAgentResult.workerId). Aqui solo se traduce a
 * algo que una interfaz pueda mostrar sin tener que conocer la convencion.
 *
 * Convencion de ids (docs/service-bus-ollama-worker.md):
 *   gce-l4      VM con GPU en Google Cloud
 *   colab-t4    notebook de Colab
 *   mac-m3      portatil Apple Silicon
 *   pc-eyder    equipo de escritorio
 */
export type WorkerProvider =
  | "gcp"
  | "colab"
  | "mac"
  | "pc"
  | "azure"
  | "local"
  | "unknown";

export type WorkerIdentity = {
  /** Id crudo tal como lo reporto el worker. Vacio si no hubo ninguno. */
  id: string;
  provider: WorkerProvider;
  /** Texto corto para la interfaz: "Google Cloud - L4". */
  label: string;
  /** Acelerador deducido del sufijo del id, si lo hay: "L4", "T4", "M3". */
  accelerator: string;
  /** Modo del backend que resolvio el job: local | azure | queue. */
  mode: string;
  observedAt: string;
};

const PROVIDER_RULES: Array<{
  test: RegExp;
  provider: WorkerProvider;
  label: string;
}> = [
  { test: /^(gce|gcp|google)\b/i, provider: "gcp", label: "Google Cloud" },
  { test: /^colab\b/i, provider: "colab", label: "Colab" },
  { test: /^(mac|mbp|imac|apple)\b/i, provider: "mac", label: "Mac" },
  { test: /^(pc|win|desktop)\b/i, provider: "pc", label: "PC local" },
  { test: /^azure\b/i, provider: "azure", label: "Azure" },
  { test: /^local\b/i, provider: "local", label: "Este servidor" },
];

const ACCELERATOR_RULE =
  /[-_](l4|t4|a100|h100|v100|p100|rtx\d*\w*|gtx\d*\w*|m[1-9]\w*|cpu)\b/i;

function splitId(rawId: string) {
  // "gce-l4" -> ["gce-l4", "l4"]; el id se normaliza a minusculas y sin espacios.
  const id = String(rawId || "").trim().replace(/\s+/g, "-").toLowerCase();
  const accelerator = id.match(ACCELERATOR_RULE)?.[1] || "";
  return { id, accelerator };
}

function prettyAccelerator(value: string) {
  if (!value) return "";
  if (/^m[1-9]/i.test(value)) return value.toUpperCase();
  if (value.toLowerCase() === "cpu") return "CPU";
  return value.toUpperCase();
}

/**
 * Traduce un id de worker a algo presentable. Nunca lanza: un id
 * desconocido cae en provider "unknown" con el id crudo como etiqueta,
 * que sigue siendo mas util que no mostrar nada.
 */
export function describeWorker(
  rawId: string | undefined,
  options: { mode?: string } = {},
): WorkerIdentity {
  const mode = String(options.mode || env.targetMode || "").toLowerCase();
  const { id, accelerator } = splitId(rawId || "");
  const observedAt = new Date().toISOString();

  if (!id) {
    // Sin id: en modo local el trabajo lo hizo este mismo proceso.
    if (mode === "local") {
      return {
        id: "",
        provider: "local",
        label: `Este servidor (${os.hostname()})`,
        accelerator: "",
        mode,
        observedAt,
      };
    }
    return {
      id: "",
      provider: "unknown",
      label: "Sin identificar",
      accelerator: "",
      mode,
      observedAt,
    };
  }

  const rule = PROVIDER_RULES.find((entry) => entry.test.test(id));
  const pretty = prettyAccelerator(accelerator);
  const label = rule
    ? pretty
      ? `${rule.label} - ${pretty}`
      : rule.label
    : id;

  return {
    id,
    provider: rule?.provider || "unknown",
    label,
    accelerator: pretty,
    mode,
    observedAt,
  };
}

let lastWorker: WorkerIdentity | null = null;

/** Guarda quien atendio el ultimo job, para exponerlo en /api/agent/backend. */
export function recordWorker(identity: WorkerIdentity) {
  if (!identity) return;
  lastWorker = identity;
}

export function getLastWorker(): WorkerIdentity | null {
  return lastWorker;
}
