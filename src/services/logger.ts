type LogLevel = "debug" | "info" | "warn" | "error";

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const secretKeyPattern = /(authorization|cookie|password|secret|token|key|connection.?string|session)/i;

function currentLogLevel(): LogLevel {
  const configured = (process.env.LOG_LEVEL || "info").trim().toLowerCase();
  return configured in levelWeights ? configured as LogLevel : "info";
}

function shouldLog(level: LogLevel) {
  return levelWeights[level] >= levelWeights[currentLogLevel()];
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(process.env.NODE_ENV === "production" ? {} : { stack: value.stack }),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        secretKeyPattern.test(key) ? "[redacted]" : sanitizeValue(item),
      ]),
    );
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  if (!shouldLog(level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeValue(fields) as Record<string, unknown>,
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logDebug(event: string, fields?: Record<string, unknown>) {
  logEvent("debug", event, fields);
}

export function logInfo(event: string, fields?: Record<string, unknown>) {
  logEvent("info", event, fields);
}

export function logWarn(event: string, fields?: Record<string, unknown>) {
  logEvent("warn", event, fields);
}

export function logError(event: string, fields?: Record<string, unknown>) {
  logEvent("error", event, fields);
}

export function toErrorFields(error: unknown) {
  return error instanceof Error
    ? { error_name: error.name, error_message: error.message }
    : { error_message: String(error) };
}
