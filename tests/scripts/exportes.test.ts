import assert from "node:assert/strict";
import test from "node:test";
import { QUIZ_COLUMNS, quizExportRecord, quizzesToCsv } from "../../scripts/lib/exportes.js";
import { actorAnonId, actorFromClientId } from "../../src/services/telemetry.js";

test("exportacion de quices: actor seudonimizado igual que la telemetria y sin textos del estudiante", () => {
  const record = quizExportRecord({
    id: "quiz-1",
    client_key: "client:vscode-piloto-0001",
    teacher_user_id: "user-teacher-demo",
    trigger_kind: "after_accept",
    launch_id: null,
    status: "completed",
    language: "cpp",
    file_path: "C:\\Users\\ana\\taller\\cuenta.cpp",
    topic: "banco RA2: encapsulamiento",
    correct_index: 2,
    chosen_index: 2,
    correct: true,
    followup_score: 70,
    created_at: "2026-09-23T10:00:00.000Z",
    answered_at: "2026-09-23T10:00:42.000Z",
    completed_at: "2026-09-23T10:01:30.000Z",
  });
  assert.deepEqual(Object.keys(record), [...QUIZ_COLUMNS]);
  assert.equal(record.actor_anon_id, actorAnonId(actorFromClientId("vscode-piloto-0001")!), "une con telemetry_events");
  assert.equal(record.actor_kind, "client");
  assert.equal(record.file_ext, ".cpp");
  assert.equal(record.seconds_to_answer, 42);
  const csv = quizzesToCsv([record]);
  for (const secret of ["vscode-piloto-0001", "user-teacher-demo", "ana", "taller"]) {
    assert.ok(!csv.includes(secret), secret);
  }
  assert.equal(csv.split("\n")[0], QUIZ_COLUMNS.join(","));
});
