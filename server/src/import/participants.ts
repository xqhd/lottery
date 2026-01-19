import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { normalizeKey } from "../strings.js";

export type ParticipantInput = {
  seq?: number;
  name: string;
  employeeId: string;
  department: string;
  weight?: number;
};

const SEQ_HEADERS = new Set(["seq", "序号", "序", "index", "序列", "no", "number"]);
const NAME_HEADERS = new Set(["name", "姓名", "名字"]);
const EMPLOYEE_ID_HEADERS = new Set(["employee_id", "employeeid", "工号", "员工号", "编号", "id"]);
const DEPT_HEADERS = new Set(["department", "dept", "部门"]);
const WEIGHT_HEADERS = new Set(["weight", "权重"]);

function cellMatches(set: Set<string>, cell: unknown): boolean {
  if (typeof cell !== "string") return false;
  return set.has(normalizeKey(cell));
}

function toText(buffer: Buffer): string {
  return buffer.toString("utf8").replace(/\r\n/g, "\n");
}

function rowsFromTxt(buffer: Buffer): unknown[][] {
  const lines = toText(buffer)
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  return lines.map((name) => [name]);
}

function rowsFromCsvText(text: string): unknown[][] {
  return parseCsv(text, { skip_empty_lines: true, bom: true });
}

type HeaderMap = {
  seqIdx: number;
  nameIdx: number;
  employeeIdIdx: number;
  departmentIdx: number;
  weightIdx: number;
};

function inferHeaderMap(rows: unknown[][]): { headerRowCount: number; map: HeaderMap } {
  const defaultMap: HeaderMap = { seqIdx: -1, nameIdx: 0, employeeIdIdx: 1, departmentIdx: 2, weightIdx: -1 };
  const header = rows[0];
  if (!header) return { headerRowCount: 0, map: defaultMap };

  const looksLikeHeader = header.some(
    (cell) =>
      cellMatches(SEQ_HEADERS, cell) ||
      cellMatches(NAME_HEADERS, cell) ||
      cellMatches(EMPLOYEE_ID_HEADERS, cell) ||
      cellMatches(DEPT_HEADERS, cell) ||
      cellMatches(WEIGHT_HEADERS, cell)
  );

  if (!looksLikeHeader) return { headerRowCount: 0, map: defaultMap };

  const map: HeaderMap = { ...defaultMap };
  let foundEmployeeId = false;
  let foundDepartment = false;
  for (let i = 0; i < header.length; i++) {
    const cell = header[i];
    if (cellMatches(SEQ_HEADERS, cell)) map.seqIdx = i;
    else if (cellMatches(NAME_HEADERS, cell)) map.nameIdx = i;
    else if (cellMatches(EMPLOYEE_ID_HEADERS, cell)) {
      map.employeeIdIdx = i;
      foundEmployeeId = true;
    } else if (cellMatches(DEPT_HEADERS, cell)) {
      map.departmentIdx = i;
      foundDepartment = true;
    } else if (cellMatches(WEIGHT_HEADERS, cell)) map.weightIdx = i;
  }

  // If the header row exists but no employee id column is present, don't
  // accidentally reuse "name"/"dept" columns (common when the sheet starts with 序号).
  if (!foundEmployeeId) map.employeeIdIdx = -1;
  if (!foundDepartment) map.departmentIdx = -1;

  return { headerRowCount: 1, map };
}

function coerceString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value).trim();
  return String(value).trim();
}

function coerceWeight(value: unknown): number | undefined {
  const str = coerceString(value);
  if (!str) return undefined;
  const num = Number(str);
  return Number.isFinite(num) ? num : undefined;
}

function coerceSeq(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const n = Math.floor(value);
    return n > 0 ? n : undefined;
  }
  const str = coerceString(value);
  if (!str) return undefined;
  const num = Number(str);
  if (!Number.isFinite(num)) return undefined;
  const n = Math.floor(num);
  return n > 0 ? n : undefined;
}

function parseRows(rows: unknown[][]): ParticipantInput[] {
  if (rows.length === 0) return [];

  const { headerRowCount, map } = inferHeaderMap(rows);
  const out: ParticipantInput[] = [];

  for (let i = headerRowCount; i < rows.length; i++) {
    const row = rows[i] ?? [];

    const name = coerceString(row[map.nameIdx]);
    if (!name) continue;

    const seq = map.seqIdx >= 0 ? coerceSeq(row[map.seqIdx]) : undefined;
    const employeeId = map.employeeIdIdx >= 0 ? coerceString(row[map.employeeIdIdx]) : "";
    const department = map.departmentIdx >= 0 ? coerceString(row[map.departmentIdx]) : "";
    const weight = map.weightIdx >= 0 ? coerceWeight(row[map.weightIdx]) : undefined;

    out.push({ seq: seq ?? i - headerRowCount + 1, name, employeeId, department, weight });
  }

  return out;
}

export function parseParticipantsFromUpload(file: { originalname: string; buffer: Buffer }): ParticipantInput[] {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".txt") return parseRows(rowsFromTxt(file.buffer));
  if (ext === ".csv") return parseRows(rowsFromCsvText(toText(file.buffer)));

  return [];
}
