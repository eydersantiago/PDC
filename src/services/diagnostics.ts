import { createHash } from "node:crypto";
import { trimText } from "./text-utils.js";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticFields = Record<string, unknown>;

export type DiagnosticLogger = {
  child(fields: DiagnosticFields): DiagnosticLogger;
  debug(event: string, fields?: DiagnosticFields): void;
  info(event: string, fields?: DiagnosticFields): void;
  warn(event: string, fields?: DiagnosticFields): void;
  error(event: string, fields?: DiagnosticFields): void;
};

const LEVEL_WEIGHT: Record<DiagnosticLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const STRING_LIMIT = 1200;
const ARRAY_LIMIT = 30;
const OBJECT_DEPTH_LIMIT = 5;

function configuredLevel() {
  const value = trimText(process.env.ADACEEN_LOG_LEVEL).toLowerCase();
  return (value in LEVEL_WEIGHT ? value : "info") as DiagnosticLevel;
}

function shouldLog(level: DiagnosticLevel) {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[configuredLevel()];
}

function isSensitiveKey(key: string) {
  return /authorization|cookie|token|secret|password|connection[_-]?string|private[_-]?key|api[_-]?key|worker[_-]?key|shared[_-]?secret/i
    .test(key);
}

function clipString(value: string, limit = STRING_LIMIT) {
  return value.length > limit
    ? `${value.slice(0, limit)}...[truncated:${value.length - limit}]`
    : value;
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (key && isSensitiveKey(key)) return "[redacted]";
  if (value == null) return value;
  if (typeof value === "string") return clipString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return errorSummary(value);
  if (depth >= OBJECT_DEPTH_LIMIT) return "[max-depth]";

  if (Array.isArray(value)) {
    const items = value
      .slice(0, ARRAY_LIMIT)
      .map((item) => sanitizeValue(item, "", depth + 1));
    if (value.length > ARRAY_LIMIT) {
      items.push(`[truncated:${value.length - ARRAY_LIMIT}]`);
    }
    return items;
  }

  if (typeof value === "object") {
    const output: DiagnosticFields = {};
    for (const [entryKey, entryValue] of Object.entries(value as DiagnosticFields)) {
      output[entryKey] = sanitizeValue(entryValue, entryKey, depth + 1);
    }
    return output;
  }

  return String(value);
}

export function errorSummary(error: unknown) {
  if (error instanceof Error) {
    const extra = error as Error & {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    const summary: DiagnosticFields = {
      name: error.name,
      message: error.message,
    };
    if (extra.code) summary.code = extra.code;
    if (extra.status) summary.status = extra.status;
    if (extra.statusCode) summary.statusCode = extra.statusCode;
    if (extra.cause) summary.cause = sanitizeValue(extra.cause, "cause", 1);
    if (process.env.ADACEEN_LOG_STACKS === "1" && error.stack) {
      summary.stack = error.stack.split("\n").slice(0, 10).join("\n");
    }
    return summary;
  }

  return {
    message: String(error),
  };
}

export function logDiagnostic(
  level: DiagnosticLevel,
  component: string,
  event: string,
  fields: DiagnosticFields = {},
) {
  if (!shouldLog(level)) return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    component,
    event,
    ...sanitizeValue(fields) as DiagnosticFields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else if (level === "debug") {
    console.debug(line);
  } else {
    console.info(line);
  }
}

export function createDiagnosticLogger(
  component: string,
  baseFields: DiagnosticFields = {},
): DiagnosticLogger {
  const write = (level: DiagnosticLevel, event: string, fields: DiagnosticFields = {}) => {
    logDiagnostic(level, component, event, { ...baseFields, ...fields });
  };

  return {
    child(fields: DiagnosticFields) {
      return createDiagnosticLogger(component, { ...baseFields, ...fields });
    },
    debug(event, fields) {
      write("debug", event, fields);
    },
    info(event, fields) {
      write("info", event, fields);
    },
    warn(event, fields) {
      write("warn", event, fields);
    },
    error(event, fields) {
      write("error", event, fields);
    },
  };
}

export function durationMs(startedAt: number) {
  return Date.now() - startedAt;
}

export function shortHash(value: string, length = 12) {
  const clean = String(value || "");
  if (!clean) return "";
  return createHash("sha256").update(clean).digest("hex").slice(0, length);
}

export function shortId(value: unknown, length = 12) {
  return trimText(value).slice(0, length);
}

export function textStats(value: unknown) {
  const text = String(value || "");
  return {
    chars: text.length,
    lines: text ? text.split(/\r?\n/).length : 0,
    sha256: shortHash(text),
  };
}

export function base64Stats(value: unknown) {
  const text = trimText(value);
  const normalized = text.replace(/\s+/g, "");
  return {
    chars: text.length,
    approxBytes: normalized ? Math.floor((normalized.length * 3) / 4) : 0,
    sha256: shortHash(normalized),
  };
}

export function urlSummary(value: unknown) {
  const raw = trimText(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return {
      host: parsed.host,
      path: clipString(parsed.pathname || "/", 240),
      queryKeys: [...parsed.searchParams.keys()].slice(0, 20),
    };
  } catch {
    return clipString(raw);
  }
}
