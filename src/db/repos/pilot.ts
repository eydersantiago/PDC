// AppDatabase, parte 9 de 12: piloto: bloque activo, cohortes y bitacora de cambios.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import { NO_PILOT, normalizePilotBlock, normalizePilotCohort, pilotStateFor } from "../../services/pilot.js";
import type { PilotAssignment, PilotBlock, PilotStudentState } from "../../services/pilot.js";
import { toIso } from "../rows.js";
import type { AppUser } from "../../types/app.js";
import type { TelemetryActor } from "../../services/telemetry.js";
import { WorkspaceDatabase } from "./workspace.js";

export class PilotDatabase extends WorkspaceDatabase {
  // --- Piloto con y sin tutor (A13.1, diseno AB/BA) --------------------------

  /** Bloque vigente del docente (0 = sin piloto) y la semilla con que se asignaron las cohortes. */
  async getPilotBlock(teacherUserId: string) {
    if (!teacherUserId) return { block: 0 as PilotBlock, seed: "", updatedAt: null as string | null };
    const result = await this.pool.query<{ block: number; seed: string; updated_at: string | Date }>(
      `select block, seed, updated_at from pilot_blocks where teacher_user_id = $1`,
      [teacherUserId],
    );
    const row = result.rows[0];
    if (!row) return { block: 0 as PilotBlock, seed: "", updatedAt: null as string | null };
    return { block: normalizePilotBlock(row.block), seed: row.seed || "", updatedAt: toIso(row.updated_at) as string | null };
  }

  /** Cambia de bloque y deja la marca en pilot_block_log (ventanas del analisis). */
  async setPilotBlock(teacherUserId: string, block: PilotBlock, changedByUserId: string) {
    const current = await this.getPilotBlock(teacherUserId);
    await this.pool.query(
      `
      insert into pilot_blocks (teacher_user_id, block, seed, updated_by_user_id, updated_at)
      values ($1, $2, $3, $4, now())
      on conflict (teacher_user_id) do update
      set
        block = excluded.block,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = now()
      `,
      [teacherUserId, block, current.seed, changedByUserId],
    );
    await this.pool.query(
      `insert into pilot_block_log (id, teacher_user_id, block, changed_by_user_id) values ($1, $2, $3, $4)`,
      [randomUUID(), teacherUserId, block, changedByUserId],
    );
    return this.getPilotBlock(teacherUserId);
  }

  /** Estudiantes activos del docente (para asignar cohortes). */
  async listActiveStudents(teacherUserId: string) {
    const result = await this.pool.query<{ id: string; display_name: string }>(
      `
      select id, display_name
      from users
      where teacher_user_id = $1
        and role_id = 'role-student'
        and is_active = true
      order by display_name asc
      `,
      [teacherUserId],
    );
    return result.rows.map((row) => ({ id: row.id, displayName: row.display_name }));
  }

  async listPilotAssignments(teacherUserId: string): Promise<PilotAssignment[]> {
    const result = await this.pool.query<{ student_user_id: string; cohort: string }>(
      `select student_user_id, cohort from pilot_assignments where teacher_user_id = $1`,
      [teacherUserId],
    );
    return result.rows
      .map((row) => ({ studentUserId: row.student_user_id, cohort: normalizePilotCohort(row.cohort) }))
      .filter((row): row is PilotAssignment => row.cohort === "A" || row.cohort === "B");
  }

  /**
   * Guarda las cohortes del docente. Con reset borra las anteriores; sin el,
   * solo agrega las nuevas (un estudiante no cambia de cohorte a mitad del piloto).
   */
  async savePilotAssignments(teacherUserId: string, assignments: PilotAssignment[], options: { reset: boolean; seed: string }) {
    if (options.reset) {
      await this.pool.query(`delete from pilot_assignments where teacher_user_id = $1`, [teacherUserId]);
    }
    for (const item of assignments) {
      await this.pool.query(
        `
        insert into pilot_assignments (student_user_id, teacher_user_id, cohort, assigned_at)
        values ($1, $2, $3, now())
        on conflict (student_user_id) do update
        set
          teacher_user_id = excluded.teacher_user_id,
          cohort = excluded.cohort,
          assigned_at = now()
        `,
        [item.studentUserId, teacherUserId, item.cohort],
      );
    }
    const current = await this.getPilotBlock(teacherUserId);
    await this.pool.query(
      `
      insert into pilot_blocks (teacher_user_id, block, seed, updated_at)
      values ($1, $2, $3, now())
      on conflict (teacher_user_id) do update
      set
        seed = excluded.seed,
        updated_at = now()
      `,
      [teacherUserId, current.block, options.seed],
    );
  }

  /** Estado del piloto de un estudiante: su cohorte y el bloque vigente de su docente. */
  async getPilotStateForStudent(studentUserId: string, teacherUserId: string): Promise<PilotStudentState> {
    if (!studentUserId || !teacherUserId) return NO_PILOT;
    const { block } = await this.getPilotBlock(teacherUserId);
    if (!block) return NO_PILOT;
    const result = await this.pool.query<{ cohort: string }>(
      `select cohort from pilot_assignments where student_user_id = $1 and teacher_user_id = $2`,
      [studentUserId, teacherUserId],
    );
    return pilotStateFor(normalizePilotCohort(result.rows[0]?.cohort), block);
  }

  async getPilotStateForUser(user: Pick<AppUser, "id" | "role" | "teacherUserId"> | null | undefined): Promise<PilotStudentState> {
    if (!user || user.role !== "student") return NO_PILOT;
    return this.getPilotStateForStudent(user.id, user.teacherUserId || "");
  }

  /** Para la telemetria: solo los estudiantes con sesion tienen condicion. */
  async getPilotStateForActor(actor: TelemetryActor): Promise<PilotStudentState> {
    if (actor.kind !== "user" || actor.role !== "student") return NO_PILOT;
    const studentUserId = actor.key.startsWith("user:") ? actor.key.slice(5) : "";
    const teacherUserId = actor.teacherKey.startsWith("user:") ? actor.teacherKey.slice(5) : "";
    return this.getPilotStateForStudent(studentUserId, teacherUserId);
  }

  /** Historial de bloques (para exportar las ventanas de cada condicion). */
  async listPilotBlockLog() {
    const result = await this.pool.query<{ teacher_user_id: string; block: number; changed_at: string | Date }>(
      `select teacher_user_id, block, changed_at from pilot_block_log order by changed_at asc`,
    );
    return result.rows.map((row) => ({
      teacherUserId: row.teacher_user_id,
      block: normalizePilotBlock(row.block),
      changedAt: toIso(row.changed_at),
    }));
  }
}
