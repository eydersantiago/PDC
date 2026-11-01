// Cola de acciones de codigo (A12.12): filas, normalizacion del texto y reclamo con lease (claimCodeActionForUser).
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { toIso } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";

export type ProjectCodeActionRow = {
  id: string;
  session_id: string | null;
  user_id: string;
  repo_full_name: string;
  branch: string;
  file_path: string;
  action_type: string;
  title: string;
  original_text: string;
  replacement_text: string;
  status: string;
  source: string;
  worker_instance: string;
  error_message: string;
  metadata: Record<string, unknown>;
  requested_at: string | Date;
  claimed_at: string | Date | null;
  completed_at: string | Date | null;
  updated_at: string | Date;
  lease_until?: string | Date | null;
  attempts?: number | string | null;
};

/** Columnas que devuelven las consultas de la cola (returning / select). */
export const CODE_ACTION_COLUMNS = `
  id,
  session_id,
  user_id,
  repo_full_name,
  branch,
  file_path,
  action_type,
  title,
  original_text,
  replacement_text,
  status,
  source,
  worker_instance,
  error_message,
  metadata,
  requested_at,
  claimed_at,
  completed_at,
  updated_at,
  lease_until,
  attempts
`;

/** Veces que VS Code puede reclamar un cambio sin confirmarlo antes de que venza. */
export const CODE_ACTION_MAX_CLAIMS = 2;

export function normalizeCodeActionText(value: unknown, max = 120000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, max);
}

export function normalizeReplacementOptions(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      id: trimText(item.id).slice(0, 120),
      label: trimText(item.label).slice(0, 180),
      description: trimText(item.description).slice(0, 800),
      actionType: trimText(item.actionType || item.action_type).slice(0, 80),
      originalText: normalizeCodeActionText(item.originalText || item.original_text),
      replacementText: normalizeCodeActionText(item.replacementText || item.replacement_text),
      metadata: item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? item.metadata as Record<string, unknown>
        : {},
    }))
    .filter((item) => item.label || item.replacementText)
    .slice(0, 8);
}

export function isDeleteCodeActionType(value: string) {
  return /\b(delete|remove|eliminar|borrar)\b/i.test(trimText(value));
}

export function mapProjectCodeActionRow(row: ProjectCodeActionRow | undefined | null) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    filePath: row.file_path,
    actionType: row.action_type,
    title: row.title,
    originalText: row.original_text,
    replacementText: row.replacement_text,
    status: row.status,
    source: row.source,
    workerInstance: row.worker_instance,
    errorMessage: row.error_message,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    requestedAt: toIso(row.requested_at),
    claimedAt: toIso(row.claimed_at),
    completedAt: toIso(row.completed_at),
    updatedAt: toIso(row.updated_at),
    leaseUntil: toIso(row.lease_until),
    attempts: Number(row.attempts) || 0,
  };
}

/**
 * Reclama para VS Code el cambio pendiente mas antiguo del usuario en ese repo, con lease
 * (A12.12). En una transaccion real (una sola conexion):
 * 1. Los reclamos vencidos (VS Code se cerro o el aviso quedo sin respuesta) vuelven a la cola;
 *    si ya se reclamaron CODE_ACTION_MAX_CLAIMS veces, vencen. Los reclamos de antes del lease
 *    (sin lease_until) se dan por vencidos pasado un lease.
 * 2. Los pendientes mas viejos que CODE_ACTION_PENDING_TTL_MINUTES vencen: ese cambio ya no es
 *    el que el estudiante esta mirando.
 * 3. Se reclama el mas antiguo que queda (lease_until = ahora + CODE_ACTION_LEASE_SECONDS). El
 *    update exige status = 'pending': si dos VS Code eligen el mismo, solo uno lo obtiene (sin
 *    «for update skip locked», que pg-mem no soporta en las pruebas).
 */
export async function claimCodeActionForUser(
  database: AppDatabase,
  input: { userId: string; repoFullName: string; workerInstance: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const leaseMs = env.codeActionLeaseSeconds * 1000;
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const legacyClaimCutoff = new Date(now.getTime() - leaseMs);
  const pendingCutoff = new Date(now.getTime() - env.codeActionPendingTtlMinutes * 60 * 1000);

  return database.withTransaction(async (client) => {
    await client.query(
      `
      update project_code_actions
      set
        status = case when attempts >= $4::int then 'expired' else 'pending' end,
        error_message = case when attempts >= $4::int then $5 else '' end,
        lease_until = null,
        worker_instance = '',
        updated_at = now()
      where user_id = $1
        and repo_full_name = $2
        and status = 'claimed'
        and (
          (lease_until is not null and lease_until < $3::timestamptz)
          or (lease_until is null and claimed_at < $6::timestamptz)
        )
      `,
      [
        input.userId,
        input.repoFullName,
        now.toISOString(),
        CODE_ACTION_MAX_CLAIMS,
        `VS Code no confirmo el cambio despues de ${CODE_ACTION_MAX_CLAIMS} reclamos.`,
        legacyClaimCutoff.toISOString(),
      ],
    );

    await client.query(
      `
      update project_code_actions
      set
        status = 'expired',
        error_message = $4,
        lease_until = null,
        updated_at = now()
      where user_id = $1
        and repo_full_name = $2
        and status = 'pending'
        and requested_at < $3::timestamptz
      `,
      [
        input.userId,
        input.repoFullName,
        pendingCutoff.toISOString(),
        `Vencio sin aplicarse (mas de ${env.codeActionPendingTtlMinutes} min en la cola).`,
      ],
    );

    const candidate = await client.query<{ id: string }>(
      `
      select id
      from project_code_actions
      where user_id = $1
        and repo_full_name = $2
        and status = 'pending'
      order by requested_at asc
      limit 1
      `,
      [input.userId, input.repoFullName],
    );
    const candidateId = trimText(candidate.rows[0]?.id);
    if (!candidateId) return null;

    const claimed = await client.query<ProjectCodeActionRow>(
      `
      update project_code_actions
      set
        status = 'claimed',
        claimed_at = now(),
        updated_at = now(),
        worker_instance = $3,
        error_message = '',
        lease_until = $4::timestamptz,
        attempts = attempts + 1
      where id = $1
        and user_id = $2
        and status = 'pending'
      returning ${CODE_ACTION_COLUMNS}
      `,
      [candidateId, input.userId, input.workerInstance, leaseUntil.toISOString()],
    );
    return claimed.rows[0] || null;
  });
}
