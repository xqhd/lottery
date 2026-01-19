import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { parseParticipantsFromUpload, type ParticipantInput } from "./import/participants.js";
import { createPrng } from "./draw/prng.js";
import { ALGORITHM_VERSION, weightedSampleWithoutReplacement } from "./draw/weightedSample.js";
import { normalizeKey } from "./strings.js";
import { nowIso } from "./time.js";
import { v4 as uuid } from "uuid";

export type Event = {
  id: string;
  name: string;
  description: string;
  startTime: string | null;
  endTime: string | null;
  settingsJson: string;
  createdAt: string;
};

export type EventBundleV1 = {
  version: 1;
  exportedAt?: string;
  event: {
    name: string;
    description?: string;
    settingsJson?: string;
  };
  prizes: Array<{
    name: string;
    level?: number;
    quantity: number;
    weight?: number;
    allowRepeat?: boolean;
    mediaUrl?: string;
  }>;
  participants: ParticipantInput[];
};

type EventRow = {
  id: string;
  name: string;
  description: string;
  start_time: string | null;
  end_time: string | null;
  settings_json: string;
  created_at: string;
};

export type Prize = {
  id: string;
  eventId: string;
  name: string;
  level: number;
  quantity: number;
  weight: number;
  allowRepeat: boolean;
  mediaUrl: string;
  drawnCount: number;
  createdAt: string;
};

type PrizeRow = {
  id: string;
  event_id: string;
  name: string;
  level: number;
  quantity: number;
  weight: number;
  allow_repeat: number;
  media_url: string;
  created_at: string;
};

export type Participant = {
  id: string;
  eventId: string;
  seq: number;
  name: string;
  employeeId: string;
  department: string;
  weight: number;
  createdAt: string;
};

export type DrawResult = {
  id: string;
  drawRunId: string;
  prizeId: string;
  prizeName: string;
  participantId: string;
  participantName: string;
  employeeId: string;
  department: string;
  timestamp: string;
  seed: string;
  candidateHash: string;
  isDeleted: boolean;
  deletedAt?: string | null;
};

export type StageStatus = {
  state: "IDLE" | "ROLLING" | "REVEAL";
  backgroundUrl?: string;
  bgmReadyUrl?: string;
  bgmRollingUrl?: string;
  bgmWinUrl?: string;
  stageEffects?: {
    confettiEnabled: boolean;
    confettiIntensity: number;
    theme: "gold" | "festive" | "simple";
  };
  prizeId?: string;
  drawRunId?: string;
  prizeName?: string;
  seed?: string;
  candidateHash?: string;
  winners?: Participant[];
  timestamp?: string;
};

export type DrawRun = {
  id: string;
  eventId: string;
  prizeId: string;
  count: number;
  seed: string;
  candidateHash: string;
  algorithmVersion: string;
  createdAt: string;
};

type ParticipantRow = {
  id: string;
  event_id: string;
  seq: number;
  name: string;
  employee_id: string;
  department: string;
  weight: number;
  created_at: string;
};

type StageStateRow = {
  event_id: string;
  state: string;
  prize_id: string | null;
  prize_name: string;
  draw_run_id: string | null;
  updated_at: string;
};

function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    startTime: row.start_time ?? null,
    endTime: row.end_time ?? null,
    settingsJson: row.settings_json,
    createdAt: row.created_at
  };
}

function toPrize(row: PrizeRow): Prize {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    level: row.level,
    quantity: row.quantity,
    weight: row.weight,
    allowRepeat: Boolean(row.allow_repeat),
    mediaUrl: row.media_url ?? "",
    drawnCount: 0,
    createdAt: row.created_at
  };
}

function toParticipant(row: ParticipantRow): Participant {
  return {
    id: row.id,
    eventId: row.event_id,
    seq: row.seq ?? 0,
    name: row.name,
    employeeId: row.employee_id,
    department: row.department,
    weight: row.weight,
    createdAt: row.created_at
  };
}

function normalizeImport(input: ParticipantInput): { seq?: number; name: string; employeeId: string; department: string; weight: number } {
  const seq = Number.isFinite(input.seq) && (input.seq as number) > 0 ? Math.floor(input.seq as number) : undefined;
  const name = input.name.trim();
  const employeeId = input.employeeId.trim();
  const department = input.department.trim();
  const weight = Number.isFinite(input.weight) ? (input.weight as number) : 1;

  return {
    seq,
    name,
    employeeId,
    department,
    weight
  };
}

function dedupeKeyForParticipant(p: { name: string; employeeId: string; department: string }): string {
  if (p.employeeId) return normalizeKey(p.employeeId);
  if (p.department) return normalizeKey(`${p.name}|${p.department}`);
  return normalizeKey(p.name);
}

export type Store = ReturnType<typeof createStore>;

function parseSettingsJson(settingsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(settingsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // ignore
  }
  return {};
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseStageEffects(settings: Record<string, unknown>): {
  confettiEnabled: boolean;
  confettiIntensity: number;
  theme: "gold" | "festive" | "simple";
} {
  const raw = settings.stageEffects;
  const next: { confettiEnabled: boolean; confettiIntensity: number; theme: "gold" | "festive" | "simple" } = {
    confettiEnabled: true,
    confettiIntensity: 1,
    theme: "gold"
  };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return next;
  const rec = raw as Record<string, unknown>;

  if (typeof rec.confettiEnabled === "boolean") next.confettiEnabled = rec.confettiEnabled;
  if (typeof rec.confettiIntensity === "number") next.confettiIntensity = clampNumber(rec.confettiIntensity, 0.5, 2.0);
  if (rec.theme === "gold" || rec.theme === "festive" || rec.theme === "simple") next.theme = rec.theme;
  return next;
}

export function createStore(db: Db) {
  const insertEvent = db.prepare(`
    INSERT INTO events (id, name, description, start_time, end_time, settings_json, created_at)
    VALUES (@id, @name, @description, @start_time, @end_time, @settings_json, @created_at)
  `);

  const getEventById = db.prepare(`SELECT * FROM events WHERE id = ?`);
  const listEventsByCreatedAt = db.prepare(`SELECT * FROM events ORDER BY created_at DESC`);
  const updateEventSettingsJson = db.prepare(`UPDATE events SET settings_json = @settings_json WHERE id = @id`);
  const deleteEventById = db.prepare(`DELETE FROM events WHERE id = ?`);
  const deleteAuditLogsByEventId = db.prepare(`DELETE FROM audit_logs WHERE event_id = ?`);

  const insertPrize = db.prepare(`
    INSERT INTO prizes (id, event_id, name, level, quantity, weight, allow_repeat, media_url, created_at)
    VALUES (@id, @event_id, @name, @level, @quantity, @weight, @allow_repeat, @media_url, @created_at)
  `);

  const listPrizesByEvent = db.prepare(`SELECT * FROM prizes WHERE event_id = ? ORDER BY level ASC, created_at ASC`);
  const getPrizeById = db.prepare(`SELECT * FROM prizes WHERE id = ?`);
  const updatePrizeById = db.prepare(`
    UPDATE prizes
    SET name = @name, level = @level, quantity = @quantity, weight = @weight, allow_repeat = @allow_repeat
    WHERE id = @id
  `);

  const updatePrizeMediaById = db.prepare(`
    UPDATE prizes
    SET media_url = @media_url
    WHERE id = @id
  `);

  const listDrawnCountsByPrizeByEvent = db.prepare(`
    SELECT run.prize_id AS prize_id, COUNT(*) AS drawn_count
    FROM draw_results res
    JOIN draw_runs run ON run.id = res.draw_run_id
    WHERE run.event_id = ?
      AND COALESCE(res.is_deleted, 0) = 0
    GROUP BY run.prize_id
  `);

  const getDrawnCountByPrizeByEvent = db.prepare(`
    SELECT COUNT(*) AS drawn_count
    FROM draw_results res
    JOIN draw_runs run ON run.id = res.draw_run_id
    WHERE run.event_id = ?
      AND run.prize_id = ?
      AND COALESCE(res.is_deleted, 0) = 0
  `);

  const getParticipantIdByKey = db.prepare(`SELECT id, seq FROM participants WHERE event_id = ? AND dedupe_key = ?`);

  const insertParticipant = db.prepare(`
    INSERT INTO participants (id, event_id, seq, name, employee_id, department, weight, dedupe_key, created_at)
    VALUES (@id, @event_id, @seq, @name, @employee_id, @department, @weight, @dedupe_key, @created_at)
  `);

  const updateParticipantByIdInImport = db.prepare(`
    UPDATE participants
    SET seq = @seq,
        name = @name,
        employee_id = @employee_id,
        department = @department,
        weight = @weight,
        dedupe_key = @dedupe_key
    WHERE id = @id
  `);

  const listParticipantsByEvent = db.prepare(`
    SELECT id, event_id, seq, name, employee_id, department, weight, created_at
    FROM participants
    WHERE event_id = ?
    ORDER BY (seq = 0) ASC, seq ASC, created_at ASC
  `);

  const listParticipantsPageByEvent = db.prepare(`
    SELECT id, event_id, seq, name, employee_id, department, weight, created_at
    FROM participants
    WHERE event_id = @event_id
      AND (
        @q = ''
        OR name LIKE @like
        OR employee_id LIKE @like
        OR department LIKE @like
      )
    ORDER BY (seq = 0) ASC, seq ASC, created_at ASC
    LIMIT @limit OFFSET @offset
  `);

  const countParticipantsPageByEvent = db.prepare(`
    SELECT COUNT(*) AS total
    FROM participants
    WHERE event_id = @event_id
      AND (
        @q = ''
        OR name LIKE @like
        OR employee_id LIKE @like
        OR department LIKE @like
      )
  `);

  const sampleParticipantsByEvent = db.prepare(`
    SELECT id, event_id, seq, name, employee_id, department, weight, created_at
    FROM participants
    WHERE event_id = ?
    ORDER BY RANDOM()
    LIMIT ?
  `);

  const countParticipantsByEvent = db.prepare(`
    SELECT COUNT(*) AS total
    FROM participants
    WHERE event_id = ?
  `);

  const getMaxParticipantSeqByEvent = db.prepare(`
    SELECT MAX(seq) AS max_seq
    FROM participants
    WHERE event_id = ?
  `);

  const getParticipantById = db.prepare(`
    SELECT id, event_id, seq, name, employee_id, department, weight, dedupe_key, created_at
    FROM participants
    WHERE id = ?
  `);

  const updateParticipantById = db.prepare(`
    UPDATE participants
    SET name = @name,
        employee_id = @employee_id,
        department = @department,
        weight = @weight,
        dedupe_key = @dedupe_key
    WHERE id = @id
  `);

  const deleteParticipantById = db.prepare(`DELETE FROM participants WHERE id = ?`);
  const deleteParticipantsByEvent = db.prepare(`DELETE FROM participants WHERE event_id = ?`);
  const hasDrawResultByParticipantId = db.prepare(`SELECT 1 FROM draw_results WHERE participant_id = ? LIMIT 1`);
  const hasActiveResultByEvent = db.prepare(`
    SELECT 1
    FROM draw_results r
    JOIN draw_runs dr ON dr.id = r.draw_run_id
    WHERE dr.event_id = ?
      AND COALESCE(r.is_deleted, 0) = 0
    LIMIT 1
  `);

  const listResultsByEvent = db.prepare(`
    SELECT
      r.id AS result_id,
      dr.id AS draw_run_id,
      dr.created_at AS draw_time,
      dr.seed AS seed,
      dr.candidate_hash AS candidate_hash,
      pr.id AS prize_id,
      dr.prize_name AS prize_name,
      p.id AS participant_id,
      p.name AS participant_name,
      p.employee_id AS employee_id,
      p.department AS department,
      r.created_at AS result_time,
      COALESCE(r.is_deleted, 0) AS is_deleted,
      r.deleted_at AS deleted_at
    FROM draw_results r
    JOIN draw_runs dr ON dr.id = r.draw_run_id
    JOIN prizes pr ON pr.id = dr.prize_id
    JOIN participants p ON p.id = r.participant_id
    WHERE dr.event_id = ?
      AND (? = 1 OR COALESCE(r.is_deleted, 0) = 0)
    ORDER BY dr.created_at ASC, pr.level ASC, pr.created_at ASC, p.id ASC
  `);

  const getLatestDrawRunByEvent = db.prepare(`
    SELECT id, prize_id, prize_name, seed, candidate_hash, created_at
    FROM draw_runs dr
    WHERE dr.event_id = ?
      AND EXISTS (
        SELECT 1
        FROM draw_results r
        WHERE r.draw_run_id = dr.id
          AND COALESCE(r.is_deleted, 0) = 0
      )
    ORDER BY dr.created_at DESC
    LIMIT 1
  `);

  const listWinnersByDrawRun = db.prepare(`
    SELECT p.id, p.event_id, p.seq, p.name, p.employee_id, p.department, p.weight, p.created_at
    FROM draw_results r
    JOIN participants p ON p.id = r.participant_id
    WHERE r.draw_run_id = ?
      AND COALESCE(r.is_deleted, 0) = 0
    ORDER BY p.id ASC
  `);

  const listCandidatesAllowRepeat = db.prepare(`
    SELECT id, event_id, seq, name, employee_id, department, weight, created_at
    FROM participants
    WHERE event_id = ?
    ORDER BY id ASC
  `);

  const listCandidatesNoRepeat = db.prepare(`
    SELECT p.id, p.event_id, p.seq, p.name, p.employee_id, p.department, p.weight, p.created_at
    FROM participants p
    WHERE p.event_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM draw_results dr
        JOIN draw_runs r ON r.id = dr.draw_run_id
        WHERE r.event_id = ?
          AND dr.participant_id = p.id
          AND COALESCE(dr.is_deleted, 0) = 0
      )
    ORDER BY p.id ASC
  `);

  const insertDrawRun = db.prepare(`
    INSERT INTO draw_runs (
      id, event_id, prize_id, prize_name, count, seed, candidate_hash, candidate_snapshot_json, algorithm_version, created_at
    ) VALUES (
      @id, @event_id, @prize_id, @prize_name, @count, @seed, @candidate_hash, @candidate_snapshot_json, @algorithm_version, @created_at
    )
  `);

  const insertDrawResult = db.prepare(`
    INSERT INTO draw_results (id, draw_run_id, participant_id, created_at)
    VALUES (@id, @draw_run_id, @participant_id, @created_at)
  `);

  const insertAuditLog = db.prepare(`
    INSERT INTO audit_logs (id, event_id, action, actor, details_json, created_at)
    VALUES (@id, @event_id, @action, @actor, @details_json, @created_at)
  `);

  const getResultById = db.prepare(`
    SELECT
      r.id AS id,
      r.draw_run_id AS draw_run_id,
      dr.event_id AS event_id
    FROM draw_results r
    JOIN draw_runs dr ON dr.id = r.draw_run_id
    WHERE r.id = ?
  `);

  const deleteResultById = db.prepare(`
    UPDATE draw_results
    SET is_deleted = 1,
        deleted_at = @deleted_at
    WHERE id = @id
      AND COALESCE(is_deleted, 0) = 0
  `);

  const restoreResultById = db.prepare(`
    UPDATE draw_results
    SET is_deleted = 0,
        deleted_at = NULL
    WHERE id = @id
      AND COALESCE(is_deleted, 0) = 1
  `);

  const clearResultsByEvent = db.prepare(`
    UPDATE draw_results
    SET is_deleted = 1,
        deleted_at = @deleted_at
    WHERE draw_run_id IN (SELECT id FROM draw_runs WHERE event_id = @event_id)
      AND COALESCE(is_deleted, 0) = 0
  `);

  const getStageStateByEvent = db.prepare(`
    SELECT event_id, state, prize_id, prize_name, draw_run_id, updated_at
    FROM stage_states
    WHERE event_id = ?
  `);

  const upsertStageState = db.prepare(`
    INSERT INTO stage_states (event_id, state, prize_id, prize_name, draw_run_id, updated_at)
    VALUES (@event_id, @state, @prize_id, @prize_name, @draw_run_id, @updated_at)
    ON CONFLICT(event_id) DO UPDATE SET
      state = excluded.state,
      prize_id = excluded.prize_id,
      prize_name = excluded.prize_name,
      draw_run_id = excluded.draw_run_id,
      updated_at = excluded.updated_at
  `);

  const getDrawRunById = db.prepare(`
    SELECT id, prize_id, prize_name, seed, candidate_hash, created_at
    FROM draw_runs
    WHERE id = ?
  `);

  function upsertParticipants(
    eventId: string,
    participants: ParticipantInput[],
    actor: string,
    metadata: Record<string, unknown>
  ): { inserted: number; updated: number; skipped: number } {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    if (participants.length === 0) throw new ApiError(400, "EMPTY_IMPORT", "No participants found");

    const createdAt = nowIso();

    const tx = db.transaction(() => {
      let inserted = 0;
      let updated = 0;
      let skipped = 0;

      const maxSeqRow = getMaxParticipantSeqByEvent.get(eventId) as { max_seq: number | null } | undefined;
      const maxSeq = Number(maxSeqRow?.max_seq ?? 0);
      let nextSeq = Number.isFinite(maxSeq) && maxSeq > 0 ? Math.floor(maxSeq) + 1 : 1;

      for (const raw of participants) {
        const p = normalizeImport(raw);
        if (!p.name) {
          skipped++;
          continue;
        }

        const dedupeKey = dedupeKeyForParticipant(p);
        let existing = getParticipantIdByKey.get(eventId, dedupeKey) as { id: string; seq: number } | undefined;
        // Back-compat: older imports could accidentally set employee_id=name when the sheet started with 序号,
        // which made dedupe_key==name. If we now import with department present (dedupe_key becomes name|dept),
        // match by the legacy key to avoid inserting duplicates.
        if (!existing && !p.employeeId && p.department) {
          const legacyKey = normalizeKey(p.name);
          existing = getParticipantIdByKey.get(eventId, legacyKey) as { id: string; seq: number } | undefined;
        }
        const seq =
          p.seq !== undefined
            ? p.seq
            : existing && Number.isFinite(existing.seq) && existing.seq > 0
              ? Math.floor(existing.seq)
              : nextSeq++;

        if (!existing) {
          insertParticipant.run({
            id: uuid(),
            event_id: eventId,
            seq,
            name: p.name,
            employee_id: p.employeeId,
            department: p.department,
            weight: p.weight,
            dedupe_key: dedupeKey,
            created_at: createdAt
          });
          inserted++;
          continue;
        }

        updateParticipantByIdInImport.run({
          id: existing.id,
          seq,
          name: p.name,
          employee_id: p.employeeId,
          department: p.department,
          weight: p.weight,
          dedupe_key: dedupeKey
        });
        updated++;
      }

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "import_participants",
        actor,
        details_json: JSON.stringify({
          ...metadata,
          parsed: participants.length,
          inserted,
          updated,
          skipped
        }),
        created_at: createdAt
      });

      return { inserted, updated, skipped };
    });

    return tx();
  }

  function createEvent(input: { name: string; description?: string }): Event {
    const id = uuid();
    const createdAt = nowIso();

    const tx = db.transaction(() => {
      insertEvent.run({
        id,
        name: input.name,
        description: input.description ?? "",
        start_time: null,
        end_time: null,
        settings_json: "{}",
        created_at: createdAt
      });

      upsertStageState.run({
        event_id: id,
        state: "IDLE",
        prize_id: null,
        prize_name: "",
        draw_run_id: null,
        updated_at: createdAt
      });
    });

    tx();

    const row = getEventById.get(id) as EventRow | undefined;
    if (!row) throw new ApiError(500, "EVENT_INSERT_FAILED", "Failed to create event");
    return toEvent(row);
  }

  function getEvent(id: string): Event | null {
    const row = getEventById.get(id) as EventRow | undefined;
    return row ? toEvent(row) : null;
  }

  function listEvents(): Event[] {
    const rows = listEventsByCreatedAt.all() as EventRow[];
    return rows.map(toEvent);
  }

  function deleteEvent(eventId: string, actor = ""): { deleted: boolean } {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const createdAt = nowIso();
    const tx = db.transaction(() => {
      // Events are the owner row; FK cascades will clean up prizes/participants/draws/stage state.
      // Audit logs are not FK-linked, so delete them explicitly.
      deleteAuditLogsByEventId.run(eventId);

      const info = deleteEventById.run(eventId) as { changes: number };
      if (info.changes <= 0) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

      insertAuditLog.run({
        id: uuid(),
        event_id: "",
        action: "delete_event",
        actor,
        details_json: JSON.stringify({ eventId, name: event.name }),
        created_at: createdAt
      });

      return { deleted: true };
    });

    return tx();
  }

  function setEventBackground(eventId: string, backgroundUrl: string, actor = ""): Event {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const createdAt = nowIso();

    const tx = db.transaction(() => {
      const settings = parseSettingsJson(event.settingsJson);
      settings.backgroundUrl = backgroundUrl;

      updateEventSettingsJson.run({
        id: eventId,
        settings_json: JSON.stringify(settings)
      });

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "set_event_background",
        actor,
        details_json: JSON.stringify({ backgroundUrl }),
        created_at: createdAt
      });
    });

    tx();

    const updated = getEvent(eventId);
    if (!updated) throw new ApiError(500, "EVENT_UPDATE_FAILED", "Failed to update event background");
    return updated;
  }

  function setEventBgm(
    eventId: string,
    slot: "ready" | "rolling" | "win",
    bgmUrl: string,
    actor = ""
  ): Event {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const createdAt = nowIso();

    const tx = db.transaction(() => {
      const settings = parseSettingsJson(event.settingsJson);
      const key = slot === "ready" ? "bgmReadyUrl" : slot === "rolling" ? "bgmRollingUrl" : "bgmWinUrl";
      settings[key] = bgmUrl;

      updateEventSettingsJson.run({
        id: eventId,
        settings_json: JSON.stringify(settings)
      });

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "set_event_bgm",
        actor,
        details_json: JSON.stringify({ slot, bgmUrl }),
        created_at: createdAt
      });
    });

    tx();

    const updated = getEvent(eventId);
    if (!updated) throw new ApiError(500, "EVENT_UPDATE_FAILED", "Failed to update event bgm");
    return updated;
  }

  function setStageEffects(
    eventId: string,
    patch: { confettiEnabled?: boolean; confettiIntensity?: number; theme?: "gold" | "festive" | "simple" },
    actor = ""
  ): Event {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const createdAt = nowIso();

    const tx = db.transaction(() => {
      const settings = parseSettingsJson(event.settingsJson);
      const prev = parseStageEffects(settings);

      const next = {
        confettiEnabled: patch.confettiEnabled === undefined ? prev.confettiEnabled : Boolean(patch.confettiEnabled),
        confettiIntensity:
          patch.confettiIntensity === undefined
            ? prev.confettiIntensity
            : clampNumber(patch.confettiIntensity, 0.5, 2.0),
        theme: patch.theme === undefined ? prev.theme : patch.theme
      };

      settings.stageEffects = next;

      updateEventSettingsJson.run({
        id: eventId,
        settings_json: JSON.stringify(settings)
      });

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "set_stage_effects",
        actor,
        details_json: JSON.stringify({ stageEffects: next }),
        created_at: createdAt
      });
    });

    tx();

    const updated = getEvent(eventId);
    if (!updated) throw new ApiError(500, "EVENT_UPDATE_FAILED", "Failed to update stage effects");
    return updated;
  }

  function createPrize(
    eventId: string,
    input: { name: string; level?: number; quantity: number; weight?: number; allowRepeat?: boolean }
  ): Prize {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const id = uuid();
    const createdAt = nowIso();

    insertPrize.run({
      id,
      event_id: eventId,
      name: input.name,
      level: input.level ?? 0,
      quantity: input.quantity,
      weight: input.weight ?? 1,
      allow_repeat: input.allowRepeat ? 1 : 0,
      media_url: "",
      created_at: createdAt
    });

    const row = getPrizeById.get(id) as PrizeRow | undefined;
    if (!row) throw new ApiError(500, "PRIZE_INSERT_FAILED", "Failed to create prize");
    return toPrize(row);
  }

  function updatePrize(
    eventId: string,
    prizeId: string,
    patch: { name?: string; level?: number; quantity?: number; weight?: number; allowRepeat?: boolean },
    actor = ""
  ): Prize {
    const prizeRow = getPrizeById.get(prizeId) as PrizeRow | undefined;
    if (!prizeRow) throw new ApiError(404, "PRIZE_NOT_FOUND", "Prize not found");
    if (prizeRow.event_id !== eventId) throw new ApiError(400, "PRIZE_EVENT_MISMATCH", "Prize does not belong to event");

    const nextName = patch.name === undefined ? prizeRow.name : patch.name;
    const nextLevel = patch.level === undefined ? prizeRow.level : patch.level;
    const nextQuantity = patch.quantity === undefined ? prizeRow.quantity : patch.quantity;
    const nextWeight = patch.weight === undefined ? prizeRow.weight : patch.weight;
    const nextAllowRepeat = patch.allowRepeat === undefined ? Boolean(prizeRow.allow_repeat) : patch.allowRepeat;

    if (!nextName.trim()) throw new ApiError(400, "INVALID_PRIZE_NAME", "Prize name is required");
    if (!Number.isInteger(nextLevel)) throw new ApiError(400, "INVALID_PRIZE_LEVEL", "Prize level must be an integer");
    if (!Number.isInteger(nextQuantity) || nextQuantity <= 0) {
      throw new ApiError(400, "INVALID_PRIZE_QUANTITY", "Prize quantity must be a positive integer");
    }
    if (!Number.isFinite(nextWeight) || nextWeight <= 0) throw new ApiError(400, "INVALID_PRIZE_WEIGHT", "Prize weight must be > 0");

    const createdAt = nowIso();
    const tx = db.transaction(() => {
      updatePrizeById.run({
        id: prizeId,
        name: nextName.trim(),
        level: nextLevel,
        quantity: nextQuantity,
        weight: nextWeight,
        allow_repeat: nextAllowRepeat ? 1 : 0
      });

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "update_prize",
        actor,
        details_json: JSON.stringify({
          prizeId,
          patch
        }),
        created_at: createdAt
      });
    });

    tx();

    const updated = getPrizeById.get(prizeId) as PrizeRow | undefined;
    if (!updated) throw new ApiError(500, "PRIZE_UPDATE_FAILED", "Failed to update prize");
    return toPrize(updated);
  }

  function listPrizes(eventId: string): Prize[] {
    const rows = listPrizesByEvent.all(eventId) as PrizeRow[];
    const countRows = listDrawnCountsByPrizeByEvent.all(eventId) as Array<{ prize_id: string; drawn_count: number }>;
    const counts = new Map<string, number>();
    for (const r of countRows) {
      const drawn = Number(r.drawn_count);
      counts.set(r.prize_id, Number.isFinite(drawn) ? drawn : 0);
    }

    return rows.map((row) => {
      const prize = toPrize(row);
      const drawnCount = counts.get(prize.id) ?? 0;
      return { ...prize, drawnCount };
    });
  }

  function setPrizeMedia(eventId: string, prizeId: string, mediaUrl: string, actor = ""): Prize {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const prizeRow = getPrizeById.get(prizeId) as PrizeRow | undefined;
    if (!prizeRow) throw new ApiError(404, "PRIZE_NOT_FOUND", "Prize not found");
    if (prizeRow.event_id !== eventId) throw new ApiError(400, "PRIZE_EVENT_MISMATCH", "Prize does not belong to event");

    const createdAt = nowIso();

    const tx = db.transaction(() => {
      updatePrizeMediaById.run({ id: prizeId, media_url: mediaUrl });

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "set_prize_media",
        actor,
        details_json: JSON.stringify({ prizeId, mediaUrl }),
        created_at: createdAt
      });
    });

    tx();

    const updated = getPrizeById.get(prizeId) as PrizeRow | undefined;
    if (!updated) throw new ApiError(500, "PRIZE_UPDATE_FAILED", "Failed to update prize");
    return toPrize(updated);
  }

  function exportEventBundle(eventId: string): EventBundleV1 {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    return {
      version: 1,
      exportedAt: nowIso(),
      event: {
        name: event.name,
        description: event.description || undefined,
        settingsJson: event.settingsJson || undefined
      },
      prizes: listPrizes(eventId).map((p) => ({
        name: p.name,
        level: p.level,
        quantity: p.quantity,
        weight: p.weight,
        allowRepeat: p.allowRepeat,
        mediaUrl: p.mediaUrl || undefined
      })),
      participants: listParticipants(eventId).map((p) => ({
        name: p.name,
        employeeId: p.employeeId,
        department: p.department,
        weight: p.weight
      }))
    };
  }

  function importEventBundle(bundle: EventBundleV1, actor = ""): Event {
    const eventName = bundle.event.name.trim();
    if (!eventName) throw new ApiError(400, "INVALID_EVENT_NAME", "Event name is required");

    const createdAt = nowIso();
    const eventId = uuid();
    const description = bundle.event.description?.trim() ?? "";
    const settingsJson = bundle.event.settingsJson?.trim() || "{}";

    const participantByKey = new Map<string, ReturnType<typeof normalizeImport>>();
    for (const raw of bundle.participants ?? []) {
      const normalized = normalizeImport(raw);
      if (!normalized.name) continue;
      participantByKey.set(dedupeKeyForParticipant(normalized), normalized);
    }

    const tx = db.transaction(() => {
      insertEvent.run({
        id: eventId,
        name: eventName,
        description,
        start_time: null,
        end_time: null,
        settings_json: settingsJson,
        created_at: createdAt
      });

      upsertStageState.run({
        event_id: eventId,
        state: "IDLE",
        prize_id: null,
        prize_name: "",
        draw_run_id: null,
        updated_at: createdAt
      });

      for (const rawPrize of bundle.prizes ?? []) {
        const name = rawPrize.name.trim();
        if (!name) continue;

        const quantity = Math.floor(rawPrize.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) continue;

        const level = rawPrize.level ?? 0;
        const weight = rawPrize.weight ?? 1;
        const allowRepeat = Boolean(rawPrize.allowRepeat);
        const mediaUrl = rawPrize.mediaUrl?.trim() ?? "";

        insertPrize.run({
          id: uuid(),
          event_id: eventId,
          name,
          level: Number.isFinite(level) ? Math.floor(level) : 0,
          quantity,
          weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
          allow_repeat: allowRepeat ? 1 : 0,
          media_url: mediaUrl,
          created_at: createdAt
        });
      }

      let inserted = 0;
      let skipped = 0;
      let nextSeq = 1;
      for (const [dedupeKey, p] of participantByKey.entries()) {
        try {
          const seq = Number.isFinite(p.seq) && (p.seq as number) > 0 ? Math.floor(p.seq as number) : nextSeq++;
          insertParticipant.run({
            id: uuid(),
            event_id: eventId,
            seq,
            name: p.name,
            employee_id: p.employeeId,
            department: p.department,
            weight: p.weight,
            dedupe_key: dedupeKey,
            created_at: createdAt
          });
          inserted++;
        } catch {
          skipped++;
        }
      }

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "import_event_bundle",
        actor,
        details_json: JSON.stringify({
          version: bundle.version,
          prizes: (bundle.prizes ?? []).length,
          participants: (bundle.participants ?? []).length,
          inserted,
          skipped
        }),
        created_at: createdAt
      });
    });

    tx();

    const row = getEventById.get(eventId) as EventRow | undefined;
    if (!row) throw new ApiError(500, "EVENT_INSERT_FAILED", "Failed to import event");
    return toEvent(row);
  }

  function listParticipants(eventId: string): Participant[] {
    const rows = listParticipantsByEvent.all(eventId) as ParticipantRow[];
    return rows.map(toParticipant);
  }

  function listParticipantsPaged(eventId: string, options: { page: number; limit: number; q?: string }): { participants: Participant[]; total: number } {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const q = (options.q ?? "").trim();
    const safeLimit = Math.max(1, Math.min(200, Math.floor(options.limit)));
    const safePage = Math.max(1, Math.floor(options.page));
    const offset = (safePage - 1) * safeLimit;
    const like = q ? `%${q}%` : "";

    const rows = listParticipantsPageByEvent.all({
      event_id: eventId,
      q,
      like,
      limit: safeLimit,
      offset
    }) as ParticipantRow[];

    const countRow = countParticipantsPageByEvent.get({ event_id: eventId, q, like }) as { total: number } | undefined;
    const total = Number(countRow?.total ?? 0);

    return {
      participants: rows.map(toParticipant),
      total: Number.isFinite(total) ? total : 0
    };
  }

  function updateParticipant(
    participantId: string,
    patch: { name?: string; employeeId?: string; department?: string; weight?: number },
    actor = ""
  ): Participant {
    const row = getParticipantById.get(participantId) as
      | { id: string; event_id: string; seq: number; name: string; employee_id: string; department: string; weight: number; created_at: string }
      | undefined;
    if (!row) throw new ApiError(404, "PARTICIPANT_NOT_FOUND", "Participant not found");

    const nextName = patch.name === undefined ? row.name : patch.name;
    const nextEmployeeId = patch.employeeId === undefined ? row.employee_id : patch.employeeId;
    const nextDepartment = patch.department === undefined ? row.department : patch.department;
    const nextWeight = patch.weight === undefined ? row.weight : patch.weight;

    const name = nextName.trim();
    if (!name) throw new ApiError(400, "INVALID_PARTICIPANT_NAME", "Participant name is required");

    const employeeId = nextEmployeeId.trim();
    const department = nextDepartment.trim();
    const weight = Number.isFinite(nextWeight) ? nextWeight : 1;
    if (weight <= 0) throw new ApiError(400, "INVALID_PARTICIPANT_WEIGHT", "weight must be > 0");

    const dedupeKey = dedupeKeyForParticipant({ name, employeeId, department });

    const createdAt = nowIso();

    const tx = db.transaction(() => {
      try {
        const info = updateParticipantById.run({
          id: participantId,
          name,
          employee_id: employeeId,
          department,
          weight,
          dedupe_key: dedupeKey
        }) as { changes: number };
        if (info.changes <= 0) throw new ApiError(500, "PARTICIPANT_UPDATE_FAILED", "Failed to update participant");
      } catch {
        // Unique constraint on (event_id, dedupe_key) can be triggered here.
        throw new ApiError(409, "PARTICIPANT_DUPLICATE", "Duplicate participant", { dedupeKey });
      }

      insertAuditLog.run({
        id: uuid(),
        event_id: row.event_id,
        action: "update_participant",
        actor,
        details_json: JSON.stringify({ participantId, patch: { name, employeeId, department, weight } }),
        created_at: createdAt
      });
    });

    tx();

    return {
      id: row.id,
      eventId: row.event_id,
      seq: row.seq ?? 0,
      name,
      employeeId,
      department,
      weight,
      createdAt: row.created_at
    };
  }

  function deleteParticipant(participantId: string, actor = ""): { deleted: boolean } {
    const row = getParticipantById.get(participantId) as { id: string; event_id: string } | undefined;
    if (!row) throw new ApiError(404, "PARTICIPANT_NOT_FOUND", "Participant not found");

    const hasDraw = Boolean(hasDrawResultByParticipantId.get(participantId));
    if (hasDraw) {
      throw new ApiError(409, "PARTICIPANT_HAS_RESULTS", "Participant has draw history");
    }

    const createdAt = nowIso();
    const tx = db.transaction(() => {
      const info = deleteParticipantById.run(participantId) as { changes: number };

      insertAuditLog.run({
        id: uuid(),
        event_id: row.event_id,
        action: "delete_participant",
        actor,
        details_json: JSON.stringify({ participantId }),
        created_at: createdAt
      });

      return { deleted: info.changes > 0 };
    });
    return tx();
  }

  function clearEventParticipants(eventId: string, actor = ""): { deleted: number } {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const hasActiveResults = Boolean(hasActiveResultByEvent.get(eventId));
    if (hasActiveResults) {
      // We avoid cascading-deleting active results via participants FK.
      // Operator should clear results first (soft delete), then clear participants if needed.
      throw new ApiError(409, "EVENT_HAS_DRAWS", "Event has active draw results");
    }

    const createdAt = nowIso();
    const tx = db.transaction(() => {
      const info = deleteParticipantsByEvent.run(eventId) as { changes: number };

      upsertStageState.run({
        event_id: eventId,
        state: "IDLE",
        prize_id: null,
        prize_name: "",
        draw_run_id: null,
        updated_at: createdAt
      });

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "clear_participants",
        actor,
        details_json: JSON.stringify({ deleted: info.changes }),
        created_at: createdAt
      });

      return { deleted: info.changes };
    });

    return tx();
  }

  function sampleParticipants(eventId: string, limit: number): Participant[] {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = sampleParticipantsByEvent.all(eventId, safeLimit) as ParticipantRow[];
    return rows.map(toParticipant);
  }

  function getParticipantStats(eventId: string): { total: number } {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const row = countParticipantsByEvent.get(eventId) as { total: number } | undefined;
    const total = Number(row?.total ?? 0);
    return { total: Number.isFinite(total) ? total : 0 };
  }

  function batchImportParticipants(
    eventId: string,
    participants: ParticipantInput[],
    actor = ""
  ): { inserted: number; updated: number; skipped: number } {
    return upsertParticipants(eventId, participants, actor, { source: "json" });
  }

  function importParticipants(
    eventId: string,
    file: { originalname: string; buffer: Buffer },
    actor = ""
  ): { inserted: number; updated: number; skipped: number } {
    const parsed = parseParticipantsFromUpload(file);
    return upsertParticipants(eventId, parsed, actor, { source: "file", filename: file.originalname });
  }

  function listResults(eventId: string, options?: { includeDeleted?: boolean }): DrawResult[] {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const includeDeleted = options?.includeDeleted ? 1 : 0;

    const rows = listResultsByEvent.all(eventId, includeDeleted) as Array<{
      result_id: string;
      draw_run_id: string;
      draw_time: string;
      seed: string;
      candidate_hash: string;
      prize_id: string;
      prize_name: string;
      participant_id: string;
      participant_name: string;
      employee_id: string;
      department: string;
      result_time: string;
      is_deleted: number;
      deleted_at: string | null;
    }>;

    return rows.map((r) => ({
      id: r.result_id,
      drawRunId: r.draw_run_id,
      prizeId: r.prize_id,
      prizeName: r.prize_name,
      participantId: r.participant_id,
      participantName: r.participant_name,
      employeeId: r.employee_id,
      department: r.department,
      timestamp: r.result_time || r.draw_time,
      seed: r.seed,
      candidateHash: r.candidate_hash,
      isDeleted: Boolean(r.is_deleted),
      deletedAt: r.deleted_at
    }));
  }

  function deleteResult(resultId: string, actor = ""): { updated: boolean } {
    const row = getResultById.get(resultId) as { id: string; draw_run_id: string; event_id: string } | undefined;
    if (!row) throw new ApiError(404, "RESULT_NOT_FOUND", "Result not found");

    const deletedAt = nowIso();

    const tx = db.transaction(() => {
      const info = deleteResultById.run({ id: resultId, deleted_at: deletedAt }) as { changes: number };

      insertAuditLog.run({
        id: uuid(),
        event_id: row.event_id,
        action: "delete_result",
        actor,
        details_json: JSON.stringify({ resultId, drawRunId: row.draw_run_id }),
        created_at: deletedAt
      });

      return { updated: info.changes > 0 };
    });

    return tx();
  }

  function restoreResult(resultId: string, actor = ""): { updated: boolean } {
    const row = getResultById.get(resultId) as { id: string; draw_run_id: string; event_id: string } | undefined;
    if (!row) throw new ApiError(404, "RESULT_NOT_FOUND", "Result not found");

    const createdAt = nowIso();

    const tx = db.transaction(() => {
      const info = restoreResultById.run({ id: resultId }) as { changes: number };

      insertAuditLog.run({
        id: uuid(),
        event_id: row.event_id,
        action: "restore_result",
        actor,
        details_json: JSON.stringify({ resultId, drawRunId: row.draw_run_id }),
        created_at: createdAt
      });

      return { updated: info.changes > 0 };
    });

    return tx();
  }

  function clearEventResults(eventId: string, actor = ""): { updated: number } {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const deletedAt = nowIso();

    const tx = db.transaction(() => {
      const info = clearResultsByEvent.run({ event_id: eventId, deleted_at: deletedAt }) as { changes: number };

      upsertStageState.run({
        event_id: eventId,
        state: "IDLE",
        prize_id: null,
        prize_name: "",
        draw_run_id: null,
        updated_at: deletedAt
      });

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "clear_results",
        actor,
        details_json: JSON.stringify({ updated: info.changes }),
        created_at: deletedAt
      });

      return { updated: info.changes };
    });

    return tx();
  }

  function setStageIdle(eventId: string, actor = ""): { updated: boolean } {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const updatedAt = nowIso();

    const tx = db.transaction(() => {
      const info = upsertStageState.run({
        event_id: eventId,
        state: "IDLE",
        prize_id: null,
        prize_name: "",
        draw_run_id: null,
        updated_at: updatedAt
      }) as { changes: number };

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "stage_idle",
        actor,
        details_json: JSON.stringify({}),
        created_at: updatedAt
      });

      return { updated: info.changes > 0 };
    });

    return tx();
  }

  function startRolling(eventId: string, prizeId: string, actor = ""): { state: "ROLLING"; prizeId: string; prizeName: string } {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const prizeRow = getPrizeById.get(prizeId) as PrizeRow | undefined;
    if (!prizeRow) throw new ApiError(404, "PRIZE_NOT_FOUND", "Prize not found");
    const prize = toPrize(prizeRow);
    if (prize.eventId !== eventId) throw new ApiError(400, "PRIZE_EVENT_MISMATCH", "Prize does not belong to event");

    const updatedAt = nowIso();

    const tx = db.transaction(() => {
      upsertStageState.run({
        event_id: eventId,
        state: "ROLLING",
        prize_id: prizeId,
        prize_name: prize.name,
        draw_run_id: null,
        updated_at: updatedAt
      });

      insertAuditLog.run({
        id: uuid(),
        event_id: eventId,
        action: "start_rolling",
        actor,
        details_json: JSON.stringify({ prizeId }),
        created_at: updatedAt
      });
    });

    tx();

    return { state: "ROLLING", prizeId, prizeName: prize.name };
  }

  function getStageStatus(eventId: string): StageStatus {
    const event = getEvent(eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const settings = parseSettingsJson(event.settingsJson);
    const backgroundUrl = typeof settings.backgroundUrl === "string" ? (settings.backgroundUrl as string) : "";
    const bgmReadyUrl = typeof settings.bgmReadyUrl === "string" ? (settings.bgmReadyUrl as string) : "";
    const bgmRollingUrl = typeof settings.bgmRollingUrl === "string" ? (settings.bgmRollingUrl as string) : "";
    const bgmWinUrl = typeof settings.bgmWinUrl === "string" ? (settings.bgmWinUrl as string) : "";
    const stageEffects = parseStageEffects(settings);

    const stageRow = getStageStateByEvent.get(eventId) as StageStateRow | undefined;

    if (stageRow && stageRow.state === "ROLLING") {
      return {
        state: "ROLLING",
        backgroundUrl,
        bgmReadyUrl,
        bgmRollingUrl,
        bgmWinUrl,
        stageEffects,
        prizeId: stageRow.prize_id ?? undefined,
        prizeName: stageRow.prize_name || undefined
      };
    }

    if (stageRow && stageRow.state === "IDLE") {
      return { state: "IDLE", backgroundUrl, bgmReadyUrl, bgmRollingUrl, bgmWinUrl, stageEffects };
    }

    if (stageRow && stageRow.state === "REVEAL" && stageRow.draw_run_id) {
      const byId = getDrawRunById.get(stageRow.draw_run_id) as
        | { id: string; prize_id: string; prize_name: string; seed: string; candidate_hash: string; created_at: string }
        | undefined;

      if (byId) {
        const winnerRows = listWinnersByDrawRun.all(byId.id) as ParticipantRow[];
        const winners = winnerRows.map(toParticipant);

        return {
          state: "REVEAL",
          backgroundUrl,
          bgmReadyUrl,
          bgmRollingUrl,
          bgmWinUrl,
          stageEffects,
          prizeId: byId.prize_id,
          drawRunId: byId.id,
          prizeName: byId.prize_name,
          seed: byId.seed,
          candidateHash: byId.candidate_hash,
          winners,
          timestamp: byId.created_at
        };
      }
    }

    const latest = getLatestDrawRunByEvent.get(eventId) as
      | { id: string; prize_id: string; prize_name: string; seed: string; candidate_hash: string; created_at: string }
      | undefined;
    if (!latest) return { state: "IDLE", backgroundUrl, bgmReadyUrl, bgmRollingUrl, bgmWinUrl, stageEffects };

    const winnerRows = listWinnersByDrawRun.all(latest.id) as ParticipantRow[];
    const winners = winnerRows.map(toParticipant);

    return {
      state: "REVEAL",
      backgroundUrl,
      bgmReadyUrl,
      bgmRollingUrl,
      bgmWinUrl,
      stageEffects,
      prizeId: latest.prize_id,
      drawRunId: latest.id,
      prizeName: latest.prize_name,
      seed: latest.seed,
      candidateHash: latest.candidate_hash,
      winners,
      timestamp: latest.created_at
    };
  }

  function drawWinners(input: {
    eventId: string;
    prizeId: string;
    count?: number;
    seed?: string;
    actor?: string;
  }): { drawRun: DrawRun; prize: Prize; winners: Participant[] } {
    const event = getEvent(input.eventId);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    const prizeRow = getPrizeById.get(input.prizeId) as PrizeRow | undefined;
    if (!prizeRow) throw new ApiError(404, "PRIZE_NOT_FOUND", "Prize not found");
    const prize = toPrize(prizeRow);
    if (prize.eventId !== input.eventId) throw new ApiError(400, "PRIZE_EVENT_MISMATCH", "Prize does not belong to event");

    const drawnRow = getDrawnCountByPrizeByEvent.get(input.eventId, input.prizeId) as { drawn_count: number } | undefined;
    const drawnCount = Number(drawnRow?.drawn_count ?? 0);
    const safeDrawnCount = Number.isFinite(drawnCount) ? drawnCount : 0;

    const remaining = prize.quantity - safeDrawnCount;
    if (remaining <= 0) {
      throw new ApiError(409, "PRIZE_EXHAUSTED", "Prize quota exhausted", {
        drawn: safeDrawnCount,
        quantity: prize.quantity
      });
    }

    const requestedCount = input.count ?? remaining;
    if (!Number.isInteger(requestedCount) || requestedCount <= 0) {
      throw new ApiError(400, "INVALID_COUNT", "count must be a positive integer");
    }

    if (requestedCount > remaining) {
      throw new ApiError(409, "PRIZE_INSUFFICIENT_REMAINING", "Not enough remaining prize slots", {
        requested: requestedCount,
        remaining,
        drawn: safeDrawnCount,
        quantity: prize.quantity
      });
    }

    const candidates = (prize.allowRepeat
      ? (listCandidatesAllowRepeat.all(input.eventId) as ParticipantRow[])
      : (listCandidatesNoRepeat.all(input.eventId, input.eventId) as ParticipantRow[])
    ).map(toParticipant);

    if (candidates.length < requestedCount) {
      throw new ApiError(409, "INSUFFICIENT_CANDIDATES", "Not enough eligible participants", {
        requested: requestedCount,
        eligible: candidates.length
      });
    }

    const seed = input.seed && input.seed.trim() ? input.seed.trim() : uuid();
    const rng = createPrng(seed);

    const candidateSnapshot = candidates.map((c) => ({ id: c.id, weight: c.weight }));
    const candidateSnapshotJson = JSON.stringify(candidateSnapshot);
    const candidateHash = sha256Hex(candidateSnapshotJson);

    const sampled = weightedSampleWithoutReplacement(candidateSnapshot, requestedCount, rng);
    if (sampled.length < requestedCount) {
      throw new ApiError(409, "INSUFFICIENT_WEIGHTED_CANDIDATES", "Not enough eligible participants after weighting", {
        requested: requestedCount,
        eligible: sampled.length
      });
    }

    const winnerById = new Map(candidates.map((c) => [c.id, c]));
    const winners = sampled
      .map((x) => winnerById.get(x.id))
      .filter((x): x is Participant => Boolean(x));

    const createdAt = nowIso();
    const drawRunId = uuid();

    const tx = db.transaction(() => {
      insertDrawRun.run({
        id: drawRunId,
        event_id: input.eventId,
        prize_id: input.prizeId,
        prize_name: prize.name,
        count: requestedCount,
        seed,
        candidate_hash: candidateHash,
        candidate_snapshot_json: candidateSnapshotJson,
        algorithm_version: ALGORITHM_VERSION,
        created_at: createdAt
      });

      for (const winner of winners) {
        insertDrawResult.run({
          id: uuid(),
          draw_run_id: drawRunId,
          participant_id: winner.id,
          created_at: createdAt
        });
      }

      insertAuditLog.run({
        id: uuid(),
        event_id: input.eventId,
        action: "draw",
        actor: input.actor ?? "",
        details_json: JSON.stringify({
          prizeId: input.prizeId,
          drawRunId,
          count: requestedCount,
          seed,
          candidateHash
        }),
        created_at: createdAt
      });

      upsertStageState.run({
        event_id: input.eventId,
        state: "REVEAL",
        prize_id: input.prizeId,
        prize_name: prize.name,
        draw_run_id: drawRunId,
        updated_at: createdAt
      });
    });

    tx();

    return {
      drawRun: {
        id: drawRunId,
        eventId: input.eventId,
        prizeId: input.prizeId,
        count: requestedCount,
        seed,
        candidateHash,
        algorithmVersion: ALGORITHM_VERSION,
        createdAt
      },
      prize,
      winners
    };
  }

  return {
    createEvent,
    getEvent,
    listEvents,
    deleteEvent,
    setEventBackground,
    setEventBgm,
    setStageEffects,
    createPrize,
    updatePrize,
    listPrizes,
    setPrizeMedia,
    listParticipants,
    listParticipantsPaged,
    updateParticipant,
    deleteParticipant,
    clearEventParticipants,
    getParticipantStats,
    sampleParticipants,
    batchImportParticipants,
    importParticipants,
    listResults,
    deleteResult,
    restoreResult,
    clearEventResults,
    startRolling,
    setStageIdle,
    getStageStatus,
    drawWinners,
    exportEventBundle,
    importEventBundle
  };
}
