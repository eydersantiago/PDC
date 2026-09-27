// AppDatabase, parte 5 de 12: lotes de RAG por curso, lote activo, fuentes apagadas y lote por estudiante.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import type { AppUser } from "../../types/app.js";
import { BASE_LOT_ID, resolveEffectiveLot } from "../../services/rag-lots.js";
import type { EffectiveRagLot, RagLot, RagSourceOverride, RagStudentLot } from "../../services/rag-lots.js";
import { DEFAULT_RAG_COURSE_CODE, normalizeRagCourseCode } from "../../services/rag-courses.js";
import { mapRagLotRow } from "../rows.js";
import type { RagLotRow } from "../rows.js";
import { trimText } from "../../services/text-utils.js";
import { PolicyDatabase } from "./policy.js";

export class RagLotsDatabase extends PolicyDatabase {
  // ---- Lotes de RAG por curso (0.7.15; services/rag-lots.ts) ----

  private async ragTeacherIdForUser(user: AppUser | null) {
    if (!user) return "";
    if (user.role === "teacher") return user.id;
    return user.teacherUserId || (await this.getDefaultTeacherId()) || "";
  }

  async resolveRagLotForUser(user: AppUser | null, courseCode: string): Promise<EffectiveRagLot> {
    const code = normalizeRagCourseCode(courseCode || DEFAULT_RAG_COURSE_CODE);
    const teacherUserId = await this.ragTeacherIdForUser(user);
    if (!teacherUserId) {
      return resolveEffectiveLot({ courseCode: code, lots: [], activeLotId: null });
    }
    const lots = await this.listRagLots(teacherUserId, code);
    const activeLotId = await this.getActiveRagLotId(teacherUserId, code);
    const studentLotId = user && user.role === "student" ? await this.getStudentRagLot(user.id, code) : null;
    return resolveEffectiveLot({ courseCode: code, lots, activeLotId, studentLotId });
  }

  async listRagLots(teacherUserId: string, courseCode?: string): Promise<RagLot[]> {
    const code = courseCode ? normalizeRagCourseCode(courseCode) : "";
    const result = await this.pool.query<RagLotRow>(
      `
      select id, teacher_user_id, course_code, name, description, includes_base, is_active, created_at, updated_at
      from rag_lots
      where teacher_user_id = $1
        and is_active = true
        and ($2 = '' or course_code = $2)
      order by created_at asc
      `,
      [teacherUserId, code],
    );
    return result.rows.map(mapRagLotRow);
  }

  async getRagLot(id: string): Promise<RagLot | null> {
    const result = await this.pool.query<RagLotRow>(
      `
      select id, teacher_user_id, course_code, name, description, includes_base, is_active, created_at, updated_at
      from rag_lots
      where id = $1
      limit 1
      `,
      [trimText(id)],
    );
    return result.rows[0] ? mapRagLotRow(result.rows[0]) : null;
  }

  async createRagLot(input: {
    teacherUserId: string;
    courseCode: string;
    name: string;
    description: string;
    includesBase: boolean;
  }): Promise<RagLot> {
    const result = await this.pool.query<RagLotRow>(
      `
      insert into rag_lots (id, teacher_user_id, course_code, name, description, includes_base, is_active, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, true, now(), now())
      returning id, teacher_user_id, course_code, name, description, includes_base, is_active, created_at, updated_at
      `,
      [randomUUID(), input.teacherUserId, normalizeRagCourseCode(input.courseCode), input.name, input.description, input.includesBase],
    );
    return mapRagLotRow(result.rows[0]);
  }

  async updateRagLot(
    id: string,
    teacherUserId: string,
    patch: { name?: string; description?: string; includesBase?: boolean },
  ): Promise<RagLot | null> {
    const current = await this.getRagLot(id);
    if (!current || current.teacherUserId !== teacherUserId || !current.isActive) return null;
    const result = await this.pool.query<RagLotRow>(
      `
      update rag_lots
      set name = $3, description = $4, includes_base = $5, updated_at = now()
      where id = $1 and teacher_user_id = $2
      returning id, teacher_user_id, course_code, name, description, includes_base, is_active, created_at, updated_at
      `,
      [
        current.id,
        teacherUserId,
        patch.name === undefined ? current.name : patch.name,
        patch.description === undefined ? current.description : patch.description,
        patch.includesBase === undefined ? current.includesBase : patch.includesBase,
      ],
    );
    return result.rows[0] ? mapRagLotRow(result.rows[0]) : null;
  }

  /** Retira un lote: deja de estar activo, sus estudiantes vuelven al lote del curso. */
  async retireRagLot(id: string, teacherUserId: string) {
    const current = await this.getRagLot(id);
    if (!current || current.teacherUserId !== teacherUserId || !current.isActive) return false;
    await this.pool.query(
      `update rag_lots set is_active = false, updated_at = now() where id = $1 and teacher_user_id = $2`,
      [current.id, teacherUserId],
    );
    await this.pool.query(
      `update rag_course_lot_settings set active_lot_id = null, updated_at = now() where teacher_user_id = $1 and active_lot_id = $2`,
      [teacherUserId, current.id],
    );
    await this.pool.query(`delete from rag_student_lots where lot_id = $1`, [current.id]);
    return true;
  }

  async getActiveRagLotId(teacherUserId: string, courseCode: string) {
    const result = await this.pool.query<{ active_lot_id: string | null }>(
      `select active_lot_id from rag_course_lot_settings where teacher_user_id = $1 and course_code = $2 limit 1`,
      [teacherUserId, normalizeRagCourseCode(courseCode)],
    );
    return trimText(result.rows[0]?.active_lot_id || "") || null;
  }

  async listActiveRagLots(teacherUserId: string) {
    const result = await this.pool.query<{ course_code: string; active_lot_id: string | null }>(
      `select course_code, active_lot_id from rag_course_lot_settings where teacher_user_id = $1`,
      [teacherUserId],
    );
    const map: Record<string, string> = {};
    for (const row of result.rows) {
      const lotId = trimText(row.active_lot_id || "");
      if (lotId) map[normalizeRagCourseCode(row.course_code)] = lotId;
    }
    return map;
  }

  /** lotId null o "" = la base del curso. El lote debe ser del docente y del curso. */
  async setActiveRagLot(teacherUserId: string, courseCode: string, lotId: string | null) {
    const code = normalizeRagCourseCode(courseCode);
    const cleanLotId = trimText(lotId || "");
    if (cleanLotId) {
      const lot = await this.getRagLot(cleanLotId);
      if (!lot || lot.teacherUserId !== teacherUserId || !lot.isActive || normalizeRagCourseCode(lot.courseCode) !== code) {
        throw new Error("El lote no existe o no es de este curso.");
      }
    }
    const existing = await this.pool.query<{ course_code: string }>(
      `select course_code from rag_course_lot_settings where teacher_user_id = $1 and course_code = $2 limit 1`,
      [teacherUserId, code],
    );
    if (existing.rows[0]) {
      await this.pool.query(
        `update rag_course_lot_settings set active_lot_id = $3, updated_at = now() where teacher_user_id = $1 and course_code = $2`,
        [teacherUserId, code, cleanLotId || null],
      );
    } else {
      await this.pool.query(
        `insert into rag_course_lot_settings (teacher_user_id, course_code, active_lot_id, updated_at) values ($1, $2, $3, now())`,
        [teacherUserId, code, cleanLotId || null],
      );
    }
    return cleanLotId || BASE_LOT_ID;
  }

  async listRagSourceOverrides(teacherUserId: string): Promise<RagSourceOverride[]> {
    const result = await this.pool.query<{ source_id: string; is_active: boolean }>(
      `select source_id, is_active from rag_source_overrides where teacher_user_id = $1`,
      [teacherUserId],
    );
    return result.rows.map((row) => ({ sourceId: row.source_id, isActive: row.is_active === true }));
  }

  /** Activa o desactiva una fuente para este docente (default o propia). */
  async setRagSourceOverride(teacherUserId: string, sourceId: string, isActive: boolean) {
    const source = await this.pool.query<{ id: string; scope: string; teacher_user_id: string | null }>(
      `select id, scope, teacher_user_id from rag_sources where id = $1 and is_active = true limit 1`,
      [trimText(sourceId)],
    );
    const row = source.rows[0];
    if (!row || (row.scope === "teacher" && row.teacher_user_id !== teacherUserId)) return false;
    const existing = await this.pool.query<{ source_id: string }>(
      `select source_id from rag_source_overrides where teacher_user_id = $1 and source_id = $2 limit 1`,
      [teacherUserId, row.id],
    );
    if (existing.rows[0]) {
      await this.pool.query(
        `update rag_source_overrides set is_active = $3, updated_at = now() where teacher_user_id = $1 and source_id = $2`,
        [teacherUserId, row.id, isActive],
      );
    } else {
      await this.pool.query(
        `insert into rag_source_overrides (teacher_user_id, source_id, is_active, updated_at) values ($1, $2, $3, now())`,
        [teacherUserId, row.id, isActive],
      );
    }
    return true;
  }

  async getStudentRagLot(studentUserId: string, courseCode: string) {
    const result = await this.pool.query<{ lot_id: string }>(
      `select lot_id from rag_student_lots where student_user_id = $1 and course_code = $2 limit 1`,
      [studentUserId, normalizeRagCourseCode(courseCode)],
    );
    return trimText(result.rows[0]?.lot_id || "") || null;
  }

  async listStudentRagLots(teacherUserId: string): Promise<RagStudentLot[]> {
    const result = await this.pool.query<{ student_user_id: string; course_code: string; lot_id: string }>(
      `
      select s.student_user_id, s.course_code, s.lot_id
      from rag_student_lots s
      join rag_lots l on l.id = s.lot_id
      where l.teacher_user_id = $1 and l.is_active = true
      `,
      [teacherUserId],
    );
    return result.rows.map((row) => ({
      studentUserId: row.student_user_id,
      courseCode: normalizeRagCourseCode(row.course_code),
      lotId: row.lot_id,
    }));
  }

  /** lotId null = vuelve al lote activo del curso. El estudiante debe ser del docente. */
  async setStudentRagLot(input: { studentUserId: string; courseCode: string; lotId: string | null; teacherUserId: string }) {
    const code = normalizeRagCourseCode(input.courseCode);
    const student = await this.pool.query<{ id: string; teacher_user_id: string | null }>(
      `select id, teacher_user_id from users where id = $1 and is_active = true limit 1`,
      [trimText(input.studentUserId)],
    );
    if (!student.rows[0] || student.rows[0].teacher_user_id !== input.teacherUserId) {
      throw new Error("El estudiante no esta asignado a este docente.");
    }
    const cleanLotId = trimText(input.lotId || "");
    await this.pool.query(
      `delete from rag_student_lots where student_user_id = $1 and course_code = $2`,
      [student.rows[0].id, code],
    );
    if (!cleanLotId) return null;
    const lot = await this.getRagLot(cleanLotId);
    if (!lot || lot.teacherUserId !== input.teacherUserId || !lot.isActive || normalizeRagCourseCode(lot.courseCode) !== code) {
      throw new Error("El lote no existe o no es de este curso.");
    }
    await this.pool.query(
      `insert into rag_student_lots (student_user_id, course_code, lot_id, assigned_by_user_id, updated_at) values ($1, $2, $3, $4, now())`,
      [student.rows[0].id, code, lot.id, input.teacherUserId],
    );
    return lot.id;
  }
}
