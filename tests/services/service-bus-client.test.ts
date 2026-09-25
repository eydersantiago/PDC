import assert from "node:assert/strict";
import test from "node:test";
import {
  buildServiceBusClientOptions,
  hostFromConnectionString,
  normalizeServiceBusTransport,
  resolveProxyUrl,
} from "../../src/services/service-bus-client.js";

const CONNECTION = "Endpoint=sb://adaceen-bus.servicebus.windows.net/;SharedAccessKeyName=worker-mac;SharedAccessKey=abc=";

test("service bus: el transporte por defecto es AMQP y websockets se reconoce con sus alias", () => {
  assert.equal(normalizeServiceBusTransport(undefined), "amqp");
  assert.equal(normalizeServiceBusTransport("amqp"), "amqp");
  assert.equal(normalizeServiceBusTransport("otro"), "amqp");
  for (const value of ["websockets", "WebSocket", "ws", "wss", "443"]) {
    assert.equal(normalizeServiceBusTransport(value), "websockets", value);
  }
});

test("service bus: host del namespace desde la cadena de conexion", () => {
  assert.equal(hostFromConnectionString(CONNECTION), "adaceen-bus.servicebus.windows.net");
  assert.equal(hostFromConnectionString(""), "");
});

test("service bus: el proxy sale de HTTPS_PROXY salvo que NO_PROXY cubra el host", () => {
  const host = "adaceen-bus.servicebus.windows.net";
  assert.equal(resolveProxyUrl(host, {}), "");
  assert.equal(resolveProxyUrl(host, { HTTPS_PROXY: "http://proxy.univalle.edu.co:3128" }), "http://proxy.univalle.edu.co:3128");
  assert.equal(resolveProxyUrl(host, { https_proxy: "http://p:8080" }), "http://p:8080");
  assert.equal(resolveProxyUrl(host, { HTTPS_PROXY: "http://p:8080", NO_PROXY: ".servicebus.windows.net" }), "");
  assert.equal(resolveProxyUrl(host, { HTTPS_PROXY: "http://p:8080", NO_PROXY: "localhost,127.0.0.1" }), "http://p:8080");
  assert.equal(resolveProxyUrl(host, { HTTPS_PROXY: "http://p:8080", NO_PROXY: "*" }), "");
});

test("service bus: con websockets el cliente usa WebSocket y, si hay proxy, un agente", () => {
  assert.deepEqual(buildServiceBusClientOptions({ transport: "amqp" }), {});
  const direct = buildServiceBusClientOptions({ transport: "websockets" });
  assert.equal(typeof direct.webSocketOptions?.webSocket, "function");
  assert.equal(direct.webSocketOptions?.webSocketConstructorOptions, undefined);
  const viaProxy = buildServiceBusClientOptions({ transport: "websockets", proxyUrl: "http://proxy.univalle.edu.co:3128" });
  const agent = (viaProxy.webSocketOptions?.webSocketConstructorOptions as { agent?: { proxy?: URL } } | undefined)?.agent;
  assert.ok(agent, "falta el agente del proxy");
  assert.equal(String(agent?.proxy?.host), "proxy.univalle.edu.co:3128");
});

test("latido por proxy: el POST sale por un tunel CONNECT cuando hay proxy y directo cuando no", async () => {
  const http = await import("node:http");
  const net = await import("node:net");
  const { postJson } = await import("../../src/services/proxy-post.js");

  const received: Array<{ token: string | undefined; body: string }> = [];
  const target = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ token: req.headers["x-worker-token"] as string | undefined, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const tunnels: string[] = [];
  const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  proxy.on("connect", (req, clientSocket, head) => {
    tunnels.push(String(req.url));
    const [host, port] = String(req.url).split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  const listen = (server: import("node:http").Server) => new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as import("node:net").AddressInfo).port));
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  try {
    const url = `http://127.0.0.1:${targetPort}/api/agent/heartbeat`;
    const direct = await postJson(url, { workerId: "mac-lab01-m2" }, { headers: { "x-worker-token": "t" }, proxyUrl: "" });
    assert.equal(direct.status, 200);
    assert.equal(direct.viaProxy, false);
    assert.equal(tunnels.length, 0);

    const viaProxy = await postJson(url, { workerId: "mac-lab01-m2" }, { headers: { "x-worker-token": "t" }, proxyUrl: `http://127.0.0.1:${proxyPort}` });
    assert.equal(viaProxy.status, 200);
    assert.equal(viaProxy.viaProxy, true);
    assert.deepEqual(tunnels, [`127.0.0.1:${targetPort}`]);
    assert.equal(received.length, 2);
    assert.ok(received.every((item) => item.token === "t" && JSON.parse(item.body).workerId === "mac-lab01-m2"));
  } finally {
    await new Promise((resolve) => target.close(resolve));
    await new Promise((resolve) => proxy.close(resolve));
  }
});
