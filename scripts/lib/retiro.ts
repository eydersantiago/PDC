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
  // Analitica de aprendizaje (29-10-2026): la historia del avance y las consultas de su codigo van por el seudonimo.
  { table: "workshop_progress_snapshots", count: "select count(*) as total from workshop_progress_snapshots where actor_anon_id = $1", remove: "delete from workshop_progress_snapshots where actor_anon_id = $1", values: (ids) => [ids.actor] },
  { table: "workshop_progress_last", count: "select count(*) as total from workshop_progress_last where actor_anon_id = $1", remove: "delete from workshop_progress_last where actor_anon_id = $1", values: (ids) => [ids.actor] },
  { table: "pseudonym_lookups", count: "select count(*) as total from pseudonym_lookups where code = $1", remove: "delete from pseudonym_lookups where code = $1", values: (ids) => [ids.actor] },
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
  // Codigo de estudiante, correos de acceso extra y solicitudes de acceso (navegador 0.7.22).
  { table: "student_codes", count: "select count(*) as total from student_codes where user_id = $1", remove: "delete from student_codes where user_id = $1", values: (ids) => [ids.userId] },
  { table: "user_login_emails", count: "select count(*) as total from user_login_emails where user_id = $1", remove: "delete from user_login_emails where user_id = $1", values: (ids) => [ids.userId] },
  { table: "student_access_requests", count: "select count(*) as total from student_access_requests where target_user_id = $1 or source_user_id = $1", remove: "delete from student_access_requests where target_user_id = $1 or source_user_id = $1", values: (ids) => [ids.userId] },
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

/**
 * Cuentas de la persona (0.7.22): la del correo (principal o de acceso extra, siguiendo
 * merged_into_user_id hasta la que prevalece) y las que se unieron a ella. La primera es la que
 * prevalece.
 */
async function resolvePersonUserIds(db: Queryable, email: string): Promise<string[]> {
  const alias = await db.query<{ user_id: string }>("select user_id from user_login_emails where email = $1", [email]);
  let primary = alias.rows[0]?.user_id || "";
  if (!primary) {
    const users = await db.query<{ id: string }>("select id from users where lower(email) = $1", [email]);
    primary = users.rows[0]?.id || "";
  }
  if (!primary) return [];
  for (let hop = 0; hop < 5; hop += 1) {
    const row = await db.query<{ merged_into_user_id: string | null }>("select merged_into_user_id from users where id = $1", [primary]);
    const next = row.rows[0]?.merged_into_user_id;
    if (!next || next === primary) break;
    primary = next;
  }
  const merged = await db.query<{ id: string }>("select id from users where merged_into_user_id = $1", [primary]);
  return [primary, ...merged.rows.map((row) => row.id).filter((id) => id !== primary)];
}

export async function withdrawParticipant(db: Queryable, input: { email: string; confirm: boolean; salt: string }): Promise<WithdrawalReport> {
  if (!input.salt) throw new Error("Hace falta TELEMETRY_SALT (la del App Service) para encontrar la telemetria del participante.");
  const email = input.email.trim().toLowerCase();
  // El retiro es de la persona, no del correo: todas sus cuentas (0.7.22).
  const userIds = await resolvePersonUserIds(db, email);
  if (!userIds.length) {
    // Sin cuenta, pero quiza pidio entrar con un codigo (0.7.22): su correo y su nombre de Google
    // quedan en student_access_requests y tambien se borran.
    const pending = await db.query<{ total: string | number }>("select count(*) as total from student_access_requests where email = $1", [email]);
    const total = Number(pending.rows[0]?.total || 0);
    if (!total) return { found: false, actorAnonId: "", counts: {}, snapshotFiles: [], confirmed: false };
    if (input.confirm) await db.query("delete from student_access_requests where email = $1", [email]);
    return { found: true, actorAnonId: "", counts: { cuentas: 0, student_access_requests_por_correo: total }, snapshotFiles: [], confirmed: input.confirm };
  }

  // Correos de la persona (principal de cada cuenta y accesos extra): sus solicitudes de acceso
  // se borran tambien las que hizo sin cuenta (correo y nombre de Google).
  const emails = new Set<string>([email]);
  for (const userId of userIds) {
    const own = await db.query<{ email: string }>("select email from users where id = $1", [userId]);
    if (own.rows[0]?.email) emails.add(String(own.rows[0].email).toLowerCase());
    const aliases = await db.query<{ email: string }>("select email from user_login_emails where user_id = $1", [userId]);
    for (const row of aliases.rows) emails.add(String(row.email).toLowerCase());
  }

  const counts: Record<string, number> = { cuentas: userIds.length };
  const add = (key: string, value: unknown) => {
    counts[key] = (counts[key] || 0) + Number(value || 0);
  };
  const snapshotFiles: string[] = [];
  const snapshotIds: string[] = [];
  const scanRequestIds: string[] = [];
  for (const userId of userIds) {
    const ids: Ids = { userId, actor: pseudonymize(`user:${userId}`), clientKey: `user:${userId}` };
    for (const step of STEPS) {
      const result = await db.query<{ total: string | number }>(step.count, step.values(ids));
      add(step.table, result.rows[0]?.total);
    }
    const requests = await db.query<{ id: string }>("select id from project_scan_requests where requested_by_user_id = $1", [userId]);
    for (const request of requests.rows) {
      scanRequestIds.push(request.id);
      const snapshots = await db.query<{ id: string; storage_path: string }>("select id, storage_path from project_scan_snapshots where request_id = $1", [request.id]);
      for (const snapshot of snapshots.rows) {
        snapshotIds.push(snapshot.id);
        if (snapshot.storage_path) snapshotFiles.push(snapshot.storage_path);
      }
    }
    const sessions = await db.query<{ total: string | number }>(ACTIVE_SESSIONS, [userId]);
    const editorSessions = await db.query<{ total: string | number }>(ACTIVE_EDITOR_SESSIONS, [userId]);
    add("app_sessions_activas", sessions.rows[0]?.total);
    add("app_sessions_editor_activas", editorSessions.rows[0]?.total);
  }
  counts.project_scan_requests = scanRequestIds.length;
  counts.project_scan_snapshots = snapshotIds.length;
  for (const personEmail of emails) {
    const result = await db.query<{ total: string | number }>(
      "select count(*) as total from student_access_requests where email = $1",
      [personEmail],
    );
    add("student_access_requests_por_correo", result.rows[0]?.total);
  }

  if (input.confirm) {
    for (const userId of userIds) {
      const ids: Ids = { userId, actor: pseudonymize(`user:${userId}`), clientKey: `user:${userId}` };
      for (const step of STEPS) await db.query(step.remove, step.values(ids));
    }
    for (const personEmail of emails) {
      await db.query("delete from student_access_requests where email = $1", [personEmail]);
    }
    for (const snapshotId of snapshotIds) {
      await db.query("delete from project_scan_snapshot_files where snapshot_id = $1", [snapshotId]);
      await db.query("delete from project_scan_snapshots where id = $1", [snapshotId]);
    }
    for (const requestId of scanRequestIds) await db.query("delete from project_scan_requests where id = $1", [requestId]);
    for (const userId of userIds) {
      // Todas las del usuario, de cualquier tipo (navegador, consola y editor):
      // «Salir» cierra la del navegador y las de VS Code, pero no las de consola.
      await db.query("update app_sessions set is_active = false where user_id = $1", [userId]);
      const tag = createHash("sha256").update(userId).digest("hex").slice(0, 10);
      await db.query(
        "update users set is_active = false, email = $2, display_name = $3, password_hash = $4 where id = $1",
        [userId, `retirado-${tag}@retirado.invalid`, "Participante retirado", `retirado:${randomBytes(24).toString("hex")}`],
      );
    }
  }
  return { found: true, actorAnonId: pseudonymize(`user:${userIds[0]}`), counts, snapshotFiles, confirmed: input.confirm };
}
