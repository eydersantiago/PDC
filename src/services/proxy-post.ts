import http from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolveProxyUrl } from "./service-bus-client.js";

/**
 * POST JSON que respeta HTTPS_PROXY y NO_PROXY.
 *
 * El fetch de Node no usa el proxy del sistema (salvo NODE_USE_ENV_PROXY en
 * Node 22.21 o 24 en adelante). En una red con proxy obligatorio, como puede
 * ser la de un laboratorio de la universidad, el latido del worker no saldria.
 * Aqui, si hay proxy para el host, la peticion sale por un tunel CONNECT
 * (el mismo agente que usa Service Bus por WebSockets); si no, va directo.
 */
export type ProxyPostResult = { status: number; body: string; viaProxy: boolean };

export function postJson(
  url: string,
  payload: unknown,
  options: { headers?: Record<string, string>; timeoutMs?: number; proxyUrl?: string } = {},
): Promise<ProxyPostResult> {
  const target = new URL(url);
  const proxyUrl = options.proxyUrl ?? resolveProxyUrl(target.hostname);
  const body = JSON.stringify(payload ?? {});
  const client = target.protocol === "https:" ? https : http;
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: "POST",
        agent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(options.headers || {}),
        },
        timeout: options.timeoutMs ?? 10000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
          viaProxy: Boolean(proxyUrl),
        }));
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error(`timeout de ${options.timeoutMs ?? 10000} ms`)));
    request.on("error", reject);
    request.end(body);
  });
}
