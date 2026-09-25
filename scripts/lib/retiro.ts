import { randomBytes, createHash } from "node:crypto";
import { pseudonymize } from "../../src/services/telemetry.js";

/**
 * Retiro de un participante del piloto (consentimiento, A13.3; lista de
 * cumplimiento C07). Borra sus datos de investigacion y de codigo, sus codigos
 * de emparejamiento de VS Code (editor_pairing_codes) y las versiones de la
 * politica de privacidad que acepto (user_privacy_acceptances), cierra todas sus
 * sesiones (navegador, consola y editor: las de VS Code del tunel y de las Mac)
 * y anonimiza la cuenta (no se borra la fila de users para no romper llaves
 * foraneas). Sin confirm solo cuenta lo que se borraria o cerraria.
 *
 * La telemetria se busca por el seudonimo, que exige la misma TELEMETRY_SALT
 * del servidor. Los archivos de las instantaneas de repositorio (storage_path)
 * se listan para borrarlos a mano: no estan en la base.
 */

export type Queryable = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

type Step = { table: string; count: string; remove: string; values: (ids: Ids) => unknown[] };
type Ids = { userId: string; actor: string; clientKey: string };

const STEPS: Step[] = [
  { table: "telemetry_events", count: "select count(*) as total from telemetry_events where actor_anon_id = $1", remove: "delete from telemetry_events where actor_anon_id = $1", values: (ids) => [ids.actor] },
  { table: "user_behavior_events", count: "select count(*) as total from user_behavior_events where user_id = $1", remove: "delete from user_behavior_events where user_id = $1", values: (ids) => [ids.userId] },
  { table: "intervention_telemetry", count: "select count(*) as total from intervention_telemetry where student_user_id = $1", remove: "delete from intervention_telemetry where student_user_id = $1", values: (ids) => [ids.userId] },
  { table: "student_exercise_progress", count: "select count(*) as total from student_exercise_progress where student_user_id = $1", remove: "delete from student_exercise_progress where student_user_id = $1", values: (ids) => [ids.userId] },
  { table: "student_quizzes", count: "select count(*) as total from student_quizzes where user_id = $1 or client_key = $2", remove: "delete from student_quizzes where user_id = $1 or client_key = $2", values: (ids) => [ids.userId, ids.clientKey] },
  { table: "pilot_assignments", count: "select count(*) as total from pilot_assignments where student_user_id = $1", remove: "delete from pilot_assignments where student_user_id = $1", values: (ids) => [ids.userId] },
  { table: "project_code_actions", count: "select count(*) as total from project_code_actions where user_id = $1", remove: "delete from project_code_actions where user_id = $1", values: (ids) => [ids.userId] },
  { table: "project_context_racks", count: "select count(*) as total from project_context_racks where user_id = $1", remove: "delete from project_context_racks where user_id = $1", values: (ids) => [ids.userId] },
  { table: "project_document_classifications", count: "select count(*) as total from project_document_classifications where user_id = $1", remove: "delete from project_document_classifications where user_id = $1", values: (ids) => [ids.userId] },
  { table: "user_active_tabs", count: "select count(*) as total from user_active_tabs where user_id = $1", remove: "delete from user_active_tabs where user_id = $1", values: (ids) => [ids.userId] },
  { table: "user_workspace_consents", count: "select count(*) as total from user_workspace_consents where user_id = $1", remove: "delete from user_workspace_consents where user_id = $1", values: (ids) => [ids.userId] },
  { table: "github_user_tokens", count: "select count(*) as total from github_user_tokens where user_id = $1", remove: "delete from github_user_tokens where user_id = $1", values: (ids) => [ids.userId] },
  { table: "github_oauth_states", count: "select count(*) as total from github_oauth_states where user_id = $1", remove: "delete from github_oauth_states where user_id = $1", values: (ids) => [ids.userId] },
  { table: "github_app_install_states", count: "select count(*) as total from github_app_install_states where user_id = $1", remove: "delete from github_app_install_states where user_id = $1", values: (ids) => [ids.userId] },
  // Solo el hash de cada codigo, pero atado al usuario: se borran usados y sin usar.
  { table: "editor_pairing_codes", count: "select count(*) as total from editor_pairing_codes where user_id = $1", remove: "delete from editor_pairing_codes where user_id = $1", values: (ids) => [ids.userId] },
  // Versiones de la politica de privacidad que acepto (una fila por version, con la fecha): la
  // constancia del consentimiento del piloto es el formulario firmado, no esta tabla.
  { table: "user_privacy_acceptances", count: "select count(*) as total from user_privacy_acceptances where user_id = $1", remove: "delete from user_privacy_acceptances where user_id = $1", values: (ids) => [ids.userId] },
];

/**
 * Sesiones que el retiro cierra (no se borran: quedan inactivas). Se cuentan
 * aparte las de VS Code (kind = 'editor'), que viven hasta 30 dias.
 */
const ACTIVE_SESSIONS = "select count(*) as total from app_sessions where user_id = $1 and is_active = true";
const ACTIVE_EDITOR_SESSIONS = "select count(*) as total from app_sessions where user_id = $1 and is_active = true and kind = 'editor'";

export type WithdrawalReport = {
  found: boolean;
  actorAnonId: string;
  counts: Record<string, number>;
  snapshotFiles: string[];
  confirmed: boolean;
};

export async function withdrawParticipant(db: Queryable, input: { email: string; confirm: boolean; salt: string }): Promise<WithdrawalReport> {
  if (!input.salt) throw new Error("Hace falta TELEMETRY_SALT (la del App Service) para encontrar la telemetria del participante.");
  const email = input.email.trim().toLowerCase();
  const users = await db.query<{ id: string }>("select id from users where lower(email) = $1", [email]);
  const userId = users.rows[0]?.id;
  if (!userId) return { found: false, actorAnonId: "", counts: {}, snapshotFiles: [], confirmed: false };

  const ids: Ids = { userId, actor: pseudonymize(`user:${userId}`), clientKey: `user:${userId}` };
  const counts: Record<string, number> = {};
  for (const step of STEPS) {
    const result = await db.query<{ total: string | number }>(step.count, step.values(ids));
    counts[step.table] = Number(result.rows[0]?.total || 0);
  }
  const requests = await db.query<{ id: string }>("select id from project_scan_requests where requested_by_user_id = $1", [userId]);
  const snapshotFiles: string[] = [];
  const snapshotIds: string[] = [];
  for (const request of requests.rows) {
    const snapshots = await db.query<{ id: string; storage_path: string }>("select id, storage_path from project_scan_snapshots where request_id = $1", [request.id]);
    for (const snapshot of snapshots.rows) {
      snapshotIds.push(snapshot.id);
      if (snapshot.storage_path) snapshotFiles.push(snapshot.storage_path);
    }
  }
  counts.project_scan_requests = requests.rows.length;
  counts.project_scan_snapshots = snapshotIds.length;
  const sessions = await db.query<{ total: string | number }>(ACTIVE_SESSIONS, [userId]);
  const editorSessions = await db.query<{ total: string | number }>(ACTIVE_EDITOR_SESSIONS, [userId]);
  counts.app_sessions_activas = Number(sessions.rows[0]?.total || 0);
  counts.app_sessions_editor_activas = Number(editorSessions.rows[0]?.total || 0);

  if (input.confirm) {
    for (const step of STEPS) await db.query(step.remove, step.values(ids));
    for (const snapshotId of snapshotIds) {
      await db.query("delete from project_scan_snapshot_files where snapshot_id = $1", [snapshotId]);
      await db.query("delete from project_scan_snapshots where id = $1", [snapshotId]);
    }
    for (const request of requests.rows) await db.query("delete from project_scan_requests where id = $1", [request.id]);
    // Todas las del usuario, de cualquier tipo (navegador, consola y editor):
    // «Salir» cierra la del navegador y las de VS Code, pero no las de consola.
    await db.query("update app_sessions set is_active = false where user_id = $1", [userId]);
    const tag = createHash("sha256").update(userId).digest("hex").slice(0, 10);
    await db.query(
      "update users set is_active = false, email = $2, display_name = $3, password_hash = $4 where id = $1",
      [userId, `retirado-${tag}@retirado.invalid`, "Participante retirado", `retirado:${randomBytes(24).toString("hex")}`],
    );
  }
  return { found: true, actorAnonId: ids.actor, counts, snapshotFiles, confirmed: input.confirm };
}
