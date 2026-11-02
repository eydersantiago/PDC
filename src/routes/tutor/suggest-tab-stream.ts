// /suggest-tab en vivo (01-11-2026, VS Code 0.0.39): con «Accept: application/x-ndjson» la
// respuesta va por lineas JSON (NDJSON) mientras el modelo escribe:
//   {"type":"partial","text":"..."}   la prosa acumulada (live-prose.ts), como mucho cada ~300 ms
//   {"type":"restart"}                 antes de la segunda llamada del reintento (borrar lo de antes)
//   {"type":"final","status":200,"body":{...}}  el mismo objeto JSON (y el mismo codigo HTTP) que
//                                      la respuesta sin la cabecera; siempre la ultima linea.
// Sin la cabecera la ruta responde como siempre (res.status(...).json(...)). El codigo HTTP es el
// del final si no se mando nada antes; si ya salio un parcial la respuesta va con 200 y el codigo
// real solo en "status" (VS Code lee ese).
import type express from "express";
import { createProseThrottle } from "../../services/vscode/live-prose.js";

export const SUGGEST_TAB_STREAM_CONTENT_TYPE = "application/x-ndjson";
/** Tope de frecuencia de las lineas "partial" (la extension repinta como mucho cada 250 ms). */
export const SUGGEST_TAB_PARTIAL_INTERVAL_MS = 300;

/** El pedido acepta NDJSON (VS Code 0.0.39 manda «Accept: application/x-ndjson, application/json;q=0.9»). */
export function wantsSuggestTabStream(req: Pick<express.Request, "header">) {
  return /(^|,)\s*application\/x-ndjson\s*(;|,|$)/i.test(String(req.header("accept") || ""));
}

export type SuggestTabReply = {
  /** Se pidio NDJSON. */
  readonly streaming: boolean;
  /** Prosa en vivo (acumulada); se escribe con tope de frecuencia. Sin NDJSON no hace nada. */
  partial(text: string): void;
  /** La segunda llamada del reintento empieza: lo mostrado en vivo se descarta. */
  restart(): void;
  /** La respuesta de siempre; despues no se escribe nada mas. */
  send(body: unknown, status?: number): void;
  /** Cuando salio el primer parcial (ms epoch), o null. */
  readonly firstPartialAt: number | null;
  /** El cliente corto la conexion antes del final. */
  readonly clientClosed: boolean;
};

/** La respuesta de /suggest-tab: JSON de siempre, o NDJSON con parciales si el pedido lo acepta. */
export function createSuggestTabReply(
  req: Pick<express.Request, "header">,
  res: express.Response,
  options: { intervalMs?: number; now?: () => number } = {},
): SuggestTabReply {
  const now = options.now ?? Date.now;
  if (!wantsSuggestTabStream(req)) {
    return {
      streaming: false,
      partial() {},
      restart() {},
      send(body, status = 200) {
        if (res.headersSent || res.writableEnded) return;
        res.status(status).json(body);
      },
      firstPartialAt: null,
      clientClosed: false,
    };
  }

  let started = false;
  let ended = false;
  let clientClosed = false;
  let firstPartialAt: number | null = null;
  let partialsSent = 0;

  const writable = () => !ended && !clientClosed && !res.destroyed && !res.writableEnded;
  const start = (status: number) => {
    if (started) return;
    started = true;
    res.status(status);
    res.setHeader("Content-Type", `${SUGGEST_TAB_STREAM_CONTENT_TYPE}; charset=utf-8`);
    res.setHeader("Cache-Control", "no-cache, no-transform");
    // nginx y otros proxies: no juntar la respuesta antes de mandarla.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  };
  const writeLine = (line: unknown) => {
    if (!writable()) return false;
    start(200);
    res.write(`${JSON.stringify(line)}\n`);
    return true;
  };

  const throttle = createProseThrottle({
    intervalMs: options.intervalMs ?? SUGGEST_TAB_PARTIAL_INTERVAL_MS,
    now,
    emit: (text) => {
      if (writeLine({ type: "partial", text })) {
        partialsSent += 1;
        if (firstPartialAt === null) firstPartialAt = now();
      }
    },
  });

  // El cliente se fue (cerro VS Code, cambio de seleccion, plazo vencido): no se escribe mas y no
  // queda ningun temporizador. El pedido sigue hasta el final (telemetria y cache), sin escribir.
  res.on("close", () => {
    if (!res.writableFinished) {
      clientClosed = true;
      throttle.cancel();
    }
  });

  return {
    streaming: true,
    partial(text: string) {
      if (!writable() || !text) return;
      throttle.push(text);
    },
    restart() {
      throttle.cancel();
      // Solo si ya se vio algo: si no, no hay nada que borrar.
      if (partialsSent > 0) writeLine({ type: "restart" });
    },
    send(body: unknown, status = 200) {
      throttle.cancel();
      if (!writable()) {
        ended = true;
        return;
      }
      start(status);
      ended = true;
      res.end(`${JSON.stringify({ type: "final", status, body })}\n`);
    },
    get firstPartialAt() {
      return firstPartialAt;
    },
    get clientClosed() {
      return clientClosed;
    },
  };
}
