import { ServiceBusClient, type ServiceBusClientOptions } from "@azure/service-bus";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import { env } from "../config/env.js";

/**
 * Cliente de Service Bus con el transporte que permita la red.
 *
 * - amqp (por defecto): AMQP sobre TLS en el puerto 5671. Es lo que usa el
 *   App Service y las VMs de Google Cloud.
 * - websockets: el mismo AMQP dentro de un WebSocket por HTTPS (puerto 443).
 *   Sirve en redes que solo dejan salir HTTPS, como las de un laboratorio de
 *   la universidad: las Mac que hacen de servidores de inferencia lo usan.
 *   Si hay proxy (HTTPS_PROXY), el WebSocket sale por el proxy.
 */
export type ServiceBusTransport = "amqp" | "websockets";

export function normalizeServiceBusTransport(value: string | undefined | null): ServiceBusTransport {
  const clean = String(value || "").trim().toLowerCase();
  return ["websockets", "websocket", "ws", "wss", "443"].includes(clean) ? "websockets" : "amqp";
}

/** Host del namespace en la cadena de conexion (Endpoint=sb://<host>/). */
export function hostFromConnectionString(connectionString: string) {
  const match = String(connectionString || "").match(/Endpoint=sb:\/\/([^/;]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function hostMatchesNoProxy(host: string, noProxy: string) {
  const entries = noProxy.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return entries.some((entry) => {
    if (entry === "*") return true;
    const bare = entry.replace(/^\*?\./, "").replace(/:\d+$/, "");
    return host === bare || host.endsWith(`.${bare}`);
  });
}

/**
 * Proxy HTTPS que corresponde al host (HTTPS_PROXY o https_proxy), salvo que
 * NO_PROXY lo excluya. Vacio si no hay proxy.
 */
export function resolveProxyUrl(host: string, vars: Record<string, string | undefined> = process.env) {
  const proxy = String(vars.HTTPS_PROXY || vars.https_proxy || "").trim();
  if (!proxy) return "";
  const noProxy = String(vars.NO_PROXY || vars.no_proxy || "");
  if (host && noProxy && hostMatchesNoProxy(host.toLowerCase(), noProxy)) return "";
  return proxy;
}

export function buildServiceBusClientOptions(input: { transport: ServiceBusTransport; proxyUrl?: string }): ServiceBusClientOptions {
  if (input.transport !== "websockets") return {};
  return {
    webSocketOptions: {
      webSocket: WebSocket as unknown as NonNullable<ServiceBusClientOptions["webSocketOptions"]>["webSocket"],
      ...(input.proxyUrl ? { webSocketConstructorOptions: { agent: new HttpsProxyAgent(input.proxyUrl) } } : {}),
    },
  };
}

export function describeServiceBusTransport(connectionString = env.serviceBusConnectionString, transportValue = env.serviceBusTransport) {
  const transport = normalizeServiceBusTransport(transportValue);
  const proxyUrl = transport === "websockets" ? resolveProxyUrl(hostFromConnectionString(connectionString)) : "";
  return { transport, viaProxy: Boolean(proxyUrl), proxyUrl };
}

export function createServiceBusClient(connectionString = env.serviceBusConnectionString, transportValue = env.serviceBusTransport) {
  const { transport, proxyUrl } = describeServiceBusTransport(connectionString, transportValue);
  return new ServiceBusClient(connectionString, buildServiceBusClientOptions({ transport, proxyUrl }));
}
