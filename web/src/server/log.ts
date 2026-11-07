/**
 * Minimal structured logger: one JSON object per line, ready for any log drain.
 * Field values whose names look secret are redacted, and key-like strings are masked.
 */
type Level = "info" | "warn" | "error";

const SECRET_FIELD = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|signature|credential/i;
const SECRET_VALUE = /\b(sk-ant-[\w-]{8,}|sk_(live|test)_[\w]{8,}|whsec_[\w]{8,}|rk_(live|test)_[\w]{8,}|Bearer\s+[\w.~+/-]{12,}|EAA[\w]{20,})/g;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]");
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_FIELD.test(k) ? "[REDACTED]" : redact(v, depth + 1)]));
}

function emit(level: Level, event: string, data?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(data ?? {}) as object) });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const log = {
  info: (event: string, data?: Record<string, unknown>) => emit("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => emit("error", event, data),
};
