import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { ServiceBusMessage, ServiceBusReceivedMessage } from "@azure/service-bus";
import { buildOllamaChatBody, readNdjsonLines, runText } from "../../runText.js";
import { createDiagnosticLogger } from "../../src/services/shared/diagnostics.js";
import {
  QUEUE_PARTIAL_SUBJECT,
  QUEUE_RESULT_SUBJECT,
  buildPartialMessage,
  buildResultMessage,
  createPartialPublisher,
  jobWantsStream,
  readPartialMessage,
  runTextJobWithPartials,
} from "../../src/services/queue/queue-stream.js";
import { QueueTimeoutError, waitForQueueResult, type QueueSessionClient } from "../../src/services/queue/service-bus-agent.js";
import { resolveTextGeneration } from "../../src/services/tutor/text-generation.js";
import { decideJobFailure, isJobStale, jobWaitDeadline } from "../../src/services/queue/queue-worker-policy.js";

// Respuesta del tutor en vivo por la cola (01-11-2026): el worker publica el texto acumulado como
// adaceen.partial en la sesion del resultado y el backend lo reenvia mientras espera el
// adaceen.result de siempre. Sin stream en el job, todo como antes.

const silentLogger = createDiagnosticLogger("prueba-cola", {});

function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Ollama falso: /api/chat con stream responde NDJSON en trozos (algunos cortan una linea a la mitad). */
async function startFakeOllama(pieces: string[], options: { doneReason?: string } = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      if (body.stream !== true) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: { content: pieces.join("") }, done: true, done_reason: options.doneReason || "stop", prompt_eval_count: 40, eval_count: pieces.length }));
        return;
      }
      res.setHeader("Content-Type", "application/x-ndjson");
      const lines = [
        ...pieces.map((piece) => JSON.stringify({ message: { role: "assistant", content: piece }, done: false })),
        JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: options.doneReason || "stop", prompt_eval_count: 40, eval_count: pieces.length }),
      ].join("\n") + "\n";
      // En trozos de 7 bytes: las lineas llegan cortadas entre dos trozos.
      const bytes = Buffer.from(lines, "utf8");
      let offset = 0;
      const tick = () => {
        if (offset >= bytes.length) return res.end();
        res.write(bytes.subarray(offset, offset + 7));
        offset += 7;
        setImmediate(tick);
      };
      tick();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ANSWER_PIECES = ["1) Resumen:\n- Falta ", "usar la clase.\n", "\n4) Accion:\nAplicar: insert\n", "```cpp\n    cout << \"Hola ñandú\";\n```\n", "\n6) Riesgos:\n- Compila."];

test("runText con stream: el Ollama falso por NDJSON da el mismo texto que sin stream y avisa el acumulado", async () => {
  const ollama = await startFakeOllama(ANSWER_PIECES);
  try {
    await withEnv({ OLLAMA_BASE_URL: ollama.base, TEXT_MODEL_API: undefined, OPENAI_BASE: undefined }, async () => {
      const plain = await runText("hola", {}, { profile: "editor" });
      const seen: string[] = [];
      const streamed = await runText("hola", {}, { profile: "editor" }, undefined, (text) => seen.push(text));
      assert.equal(streamed, plain, "el mismo texto con y sin stream");
      assert.equal(streamed, ANSWER_PIECES.join(""));
      assert.ok(seen.length >= ANSWER_PIECES.length - 1, `avisos: ${seen.length}`);
      for (let index = 1; index < seen.length; index += 1) {
        assert.ok(seen[index].startsWith(seen[index - 1]), "cada aviso trae todo lo anterior");
      }
      assert.equal(seen.at(-1), streamed);
      assert.equal(ollama.bodies[0].stream, false, "sin aviso: stream false, como siempre");
      assert.equal(ollama.bodies[1].stream, true);
      const options = ollama.bodies[1].options as Record<string, unknown>;
      assert.equal(options.num_predict, resolveTextGeneration({ profile: "editor" }).maxTokens, "respeta num_predict");
      assert.equal(options.num_ctx, (ollama.bodies[0].options as Record<string, unknown>).num_ctx);
    });
  } finally {
    await ollama.close();
  }
});

test("runText con stream: una respuesta vacia falla como sin stream", async () => {
  const ollama = await startFakeOllama(["", "   "]);
  try {
    await withEnv({ OLLAMA_BASE_URL: ollama.base, TEXT_MODEL_API: undefined, OPENAI_BASE: undefined }, async () => {
      await assert.rejects(runText("hola", {}, {}, undefined, () => {}), /Sin salida del modelo/);
    });
  } finally {
    await ollama.close();
  }
});

/** llama-server falso (API compatible con OpenAI): SSE con stream, JSON sin stream. */
async function startFakeOpenAi(pieces: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      if (body.stream !== true) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: pieces.join("") } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      for (const piece of pieces) {
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("runText con stream por la API compatible con OpenAI (llama-server de las Mac): mismo texto, avisa el acumulado", async () => {
  const server = await startFakeOpenAi(ANSWER_PIECES);
  try {
    await withEnv({ OPENAI_BASE: server.base, TEXT_MODEL_API: "openai", OLLAMA_BASE_URL: undefined }, async () => {
      const plain = await runText("hola", {}, { profile: "editor" });
      const seen: string[] = [];
      const streamed = await runText("hola", {}, { profile: "editor" }, undefined, (text) => seen.push(text));
      assert.equal(streamed, plain);
      assert.equal(seen.at(-1), streamed);
      assert.equal(server.bodies[0].stream, undefined, "sin aviso no se pide stream");
      assert.equal(server.bodies[1].stream, true);
      assert.equal(server.bodies[1].max_tokens, resolveTextGeneration({ profile: "editor" }).maxTokens);
    });
  } finally {
    await server.close();
  }
});

test("buildOllamaChatBody: sin stream sigue en false (camino de siempre)", () => {
  const settings = resolveTextGeneration({ profile: "editor" });
  assert.equal(buildOllamaChatBody("x", settings, "m").stream, false);
  assert.equal(buildOllamaChatBody("x", settings, "m", true).stream, true);
});

test("readNdjsonLines junta las lineas cortadas entre trozos y la ultima sin salto", async () => {
  const encoder = new TextEncoder();
  const chunks = ["{\"a\":1}\n{\"b\"", ":2}\n\n{\"c\":", "3}"];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const lines: string[] = [];
  for await (const line of readNdjsonLines(body)) lines.push(line);
  assert.deepEqual(lines, ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"]);
});

/** Reloj y temporizadores a mano: el tope de frecuencia se prueba sin esperar. */
function manualClock() {
  let nowMs = 0;
  const timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 1;
  return {
    now: () => nowMs,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: nowMs + ms, callback, id });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    async advance(ms: number) {
      nowMs += ms;
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const due = timers[0];
        if (!due || due.at > nowMs) break;
        timers.shift();
        due.callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    pending: () => timers.length,
  };
}

test("parciales del worker: el primero sale enseguida y despues uno cada 500 ms con el ultimo texto", async () => {
  const clock = manualClock();
  const sent: Array<{ seq: number; text: string }> = [];
  const publisher = createPartialPublisher({
    send: async (seq, text) => { sent.push({ seq, text }); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  publisher.push("a");
  await clock.advance(0);
  publisher.push("ab");
  publisher.push("abc");
  await clock.advance(100);
  assert.deepEqual(sent, [{ seq: 1, text: "a" }], "nada antes de 500 ms");
  await clock.advance(400);
  assert.deepEqual(sent.at(-1), { seq: 2, text: "abc" }, "a los 500 ms el ultimo, los intermedios se saltan");
  publisher.push("abcd");
  await clock.advance(200);
  assert.equal(sent.length, 2);
  const stats = await publisher.stop();
  assert.equal(clock.pending(), 0, "stop no deja temporizadores");
  assert.equal(stats.sent, 2);
  publisher.push("abcde");
  await clock.advance(1000);
  assert.equal(sent.length, 2, "despues de stop no sale nada");
});

test("parciales del worker: un fallo al enviar no lanza y tras 5 seguidos deja de publicar", async () => {
  const clock = manualClock();
  let attempts = 0;
  const errors: number[] = [];
  const publisher = createPartialPublisher({
    send: async () => {
      attempts += 1;
      throw new Error("Service Bus no responde");
    },
    onError: (_error, failures) => errors.push(failures),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  for (let index = 1; index <= 10; index += 1) {
    publisher.push("x".repeat(index));
    await clock.advance(500);
  }
  assert.equal(attempts, 5);
  assert.deepEqual(errors, [1, 2, 3, 4, 5]);
  const stats = await publisher.stop();
  assert.equal(stats.failures, 5);
});

test("worker: el trabajo con stream publica parciales (acumulados, en orden, sesion = jobId) y el resultado va despues", async () => {
  const messages: ServiceBusMessage[] = [];
  const sender = { sendMessages: async (message: ServiceBusMessage) => { messages.push(message); } };
  const output = await runTextJobWithPartials({
    jobId: "job-1",
    sender,
    workerId: "gpu-prueba",
    sharedSecret: "secreto",
    intervalMs: 0,
    run: async (onText) => {
      let text = "";
      for (const piece of ["Hola", " estudiante", "\n- paso"]) {
        text += piece;
        onText(text);
        await new Promise((resolve) => setImmediate(resolve));
      }
      return text;
    },
  });
  assert.equal(output, "Hola estudiante\n- paso");
  messages.push(buildResultMessage({ schemaVersion: 1, jobId: "job-1", ok: true, outputText: output, completedAt: "2026-11-01T00:00:00.000Z" }, 240_000));
  const partials = messages.filter((message) => message.subject === QUEUE_PARTIAL_SUBJECT);
  assert.ok(partials.length >= 2);
  let previous = "";
  partials.forEach((message, index) => {
    const body = JSON.parse(String(message.body));
    assert.equal(message.sessionId, "job-1");
    assert.equal(message.correlationId, "job-1");
    assert.equal(message.messageId, `job-1:p${index + 1}`);
    assert.ok(Number(message.timeToLive) <= 60_000, "TTL corto");
    assert.deepEqual(Object.keys(body).sort(), ["jobId", "partialText", "schemaVersion", "seq", "sharedSecret", "workerId"]);
    assert.equal(body.seq, index + 1);
    assert.equal(body.sharedSecret, "secreto");
    assert.ok(String(body.partialText).startsWith(previous));
    previous = body.partialText;
  });
  assert.equal(messages.at(-1)!.subject, QUEUE_RESULT_SUBJECT, "el resultado es el ultimo mensaje");
  assert.equal(messages.at(-1)!.messageId, "job-1:result");
});

test("worker: si mandar parciales falla, el trabajo termina igual con su texto", async () => {
  const sender = { sendMessages: async () => { throw new Error("sin enlace"); } };
  const output = await runTextJobWithPartials({
    jobId: "job-2",
    sender,
    intervalMs: 0,
    run: async (onText) => {
      onText("uno");
      await new Promise((resolve) => setImmediate(resolve));
      onText("uno dos");
      return "uno dos";
    },
  });
  assert.equal(output, "uno dos");
});

test("worker: si el modelo falla, los parciales se detienen y el error sigue su camino", async () => {
  const messages: ServiceBusMessage[] = [];
  await assert.rejects(runTextJobWithPartials({
    jobId: "job-3",
    sender: { sendMessages: async (message) => { messages.push(message); } },
    intervalMs: 0,
    run: async (onText) => {
      onText("algo");
      throw new Error("Ollama /api/chat HTTP 503");
    },
  }), /503/);
  await new Promise((resolve) => setImmediate(resolve));
  const count = messages.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.length, count, "nada sale despues");
});

function received(message: ServiceBusMessage): ServiceBusReceivedMessage {
  return { ...message } as unknown as ServiceBusReceivedMessage;
}

/** Receptor de sesion falso: entrega los mensajes en orden, de a uno. */
function fakeSessionClient(queue: ServiceBusMessage[], options: { neverFinal?: boolean } = {}) {
  const state = { accepted: "", closed: false, receives: 0 };
  const client: QueueSessionClient = {
    async acceptSession(_queue, sessionId) {
      state.accepted = sessionId;
      return {
        async receiveMessages(_count, receiveOptions) {
          state.receives += 1;
          const next = queue.shift();
          if (next) return [received(next)];
          if (options.neverFinal) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, receiveOptions?.maxWaitTimeInMs ?? 50)));
          }
          return [];
        },
        async close() {
          state.closed = true;
        },
      };
    },
  };
  return { client, state };
}

function partial(jobId: string, seq: number, text: string, sharedSecret = "secreto") {
  return buildPartialMessage({ jobId, seq, partialText: text, sharedSecret });
}

function finalResult(jobId: string, text: string, sharedSecret = "secreto") {
  return buildResultMessage({ schemaVersion: 1, jobId, ok: true, outputText: text, workerId: "gpu-1", sharedSecret, completedAt: "2026-11-01T00:00:00.000Z" }, 240_000);
}

test("backend: los parciales validos llegan en orden; repetidos, atrasados, de otro job o con otro secreto se ignoran", async () => {
  const { client, state } = fakeSessionClient([
    partial("job-a", 1, "Uno"),
    partial("job-a", 1, "Uno (repetido)"),
    partial("job-b", 2, "De otro trabajo"),
    partial("job-a", 3, "Uno dos tres"),
    partial("job-a", 2, "Uno dos (atrasado)"),
    partial("job-a", 4, "con otro secreto", "otro"),
    { ...partial("job-a", 5, "x"), body: "{no es json" },
    finalResult("job-a", "Uno dos tres cuatro"),
    partial("job-a", 6, "despues del final"),
  ]);
  const seen: string[] = [];
  const result = await waitForQueueResult(client, "job-a", 5_000, silentLogger, {
    onPartial: (text) => seen.push(text),
    resultsQueueName: "resultados",
    sharedSecret: "secreto",
  });
  assert.equal(state.accepted, "job-a");
  assert.deepEqual(seen, ["Uno", "Uno dos tres"]);
  assert.deepEqual(result, { outputText: "Uno dos tres cuatro", workerId: "gpu-1" });
  assert.equal(state.closed, true, "cierra el receptor");
});

test("backend sin stream (o worker viejo): el primer mensaje es el resultado, como antes", async () => {
  const { client } = fakeSessionClient([finalResult("job-c", "listo")]);
  const result = await waitForQueueResult(client, "job-c", 5_000, silentLogger, { resultsQueueName: "r", sharedSecret: "secreto" });
  assert.equal(result.outputText, "listo");

  // Con onPartial pero un worker anterior (sin parciales): solo el resultado.
  const seen: string[] = [];
  const old = fakeSessionClient([finalResult("job-d", "solo final")]);
  const oldResult = await waitForQueueResult(old.client, "job-d", 5_000, silentLogger, { onPartial: (text) => seen.push(text), resultsQueueName: "r", sharedSecret: "secreto" });
  assert.equal(oldResult.outputText, "solo final");
  assert.deepEqual(seen, []);

  // Sin onPartial, un parcial que llegara se ignora y se sigue esperando el resultado.
  const mixed = fakeSessionClient([partial("job-e", 1, "parcial"), finalResult("job-e", "final")]);
  assert.equal((await waitForQueueResult(mixed.client, "job-e", 5_000, silentLogger, { resultsQueueName: "r", sharedSecret: "secreto" })).outputText, "final");
});

test("backend: solo parciales y nunca el resultado vence en el plazo de siempre (QueueTimeoutError) y cierra", async () => {
  const { client, state } = fakeSessionClient([partial("job-f", 1, "a"), partial("job-f", 2, "ab")], { neverFinal: true });
  const seen: string[] = [];
  const started = Date.now();
  await assert.rejects(
    waitForQueueResult(client, "job-f", 300, silentLogger, { onPartial: (text) => seen.push(text), resultsQueueName: "r", sharedSecret: "secreto" }),
    (error: unknown) => error instanceof QueueTimeoutError,
  );
  assert.ok(Date.now() - started < 2_000, "no espera mas que el plazo");
  assert.deepEqual(seen, ["a", "ab"]);
  assert.equal(state.closed, true);
});

test("backend: un callback de parcial que falla no corta la espera del resultado", async () => {
  const { client } = fakeSessionClient([partial("job-g", 1, "a"), finalResult("job-g", "fin")]);
  const result = await waitForQueueResult(client, "job-g", 5_000, silentLogger, {
    onPartial: () => { throw new Error("pantalla rota"); },
    resultsQueueName: "r",
    sharedSecret: "secreto",
  });
  assert.equal(result.outputText, "fin");
});

test("readPartialMessage: el cuerpo puede llegar como texto, bytes u objeto", () => {
  const message = partial("job-h", 2, "hola");
  const text = readPartialMessage({ body: message.body }, { jobId: "job-h", lastSeq: 1, sharedSecret: "secreto" });
  const bytes = readPartialMessage({ body: new TextEncoder().encode(String(message.body)) }, { jobId: "job-h", lastSeq: 1, sharedSecret: "secreto" });
  const object = readPartialMessage({ body: JSON.parse(String(message.body)) }, { jobId: "job-h", lastSeq: 1, sharedSecret: "secreto" });
  for (const read of [text, bytes, object]) assert.deepEqual(read, { ok: true, seq: 2, attempt: 0, text: "hola", restarted: false });
  assert.deepEqual(readPartialMessage({ body: message.body }, { jobId: "job-h", lastSeq: 2, sharedSecret: "secreto" }), { ok: false, reason: "repetido" });
  assert.deepEqual(readPartialMessage({ body: message.body }, { jobId: "job-h", lastSeq: 0, sharedSecret: "" }).ok, true, "sin secreto configurado no se compara");
});

test("worker: solo un job de texto con stream: true pide la respuesta en vivo (un backend anterior no lo pone)", () => {
  assert.equal(jobWantsStream({ kind: "text", stream: true }), true);
  assert.equal(jobWantsStream({ kind: "text" }), false, "backend anterior: sin parciales, todo como antes");
  assert.equal(jobWantsStream({ kind: "text", stream: "true" }), false);
  assert.equal(jobWantsStream({ kind: "image", stream: true }), false, "las imagenes nunca");
});

/** Servidor que manda unos trozos y despues no cierra ni manda mas (o cierra sin la ultima linea). */
async function startStallingServer(write: (res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => write(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sseChunk(piece: string) {
  return `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`;
}

test("runText en vivo por la API compatible con OpenAI: un servidor que se cuelga a mitad falla por plazo (reintentable), no devuelve media respuesta", async () => {
  const server = await startStallingServer((res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(sseChunk("Hola"));
    res.write(sseChunk(" mundo"));
    // y no manda mas
  });
  try {
    await withEnv({ OPENAI_BASE: `http://127.0.0.1:${server.port}/v1`, TEXT_MODEL_API: "openai", OLLAMA_BASE_URL: undefined }, async () => {
      const seen: string[] = [];
      const started = Date.now();
      const error = await runText("hola", {}, {}, 2000, (text) => seen.push(text)).then(
        () => assert.fail("una respuesta cortada no puede volver como exito"),
        (caught: unknown) => caught,
      );
      assert.ok(Date.now() - started >= 1900, "espera el plazo");
      assert.equal((error as Error).name, "TimeoutError");
      assert.equal(seen.at(-1), "Hola mundo", "los parciales si llegaron");
      assert.deepEqual(
        decideJobFailure({ error, deliveryCount: 1, maxAttempts: 3 }),
        { settlement: "abandon", sendResult: false, reason: "retry" },
        "como sin stream: se libera para otro worker",
      );
    });
  } finally {
    await server.close();
  }
});

test("runText en vivo con Ollama: un cuerpo que cierra sin la linea done es una respuesta cortada", async () => {
  const server = await startStallingServer((res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.end(`${JSON.stringify({ message: { content: "Hola a medias" }, done: false })}\n`);
  });
  try {
    await withEnv({ OLLAMA_BASE_URL: `http://127.0.0.1:${server.port}`, TEXT_MODEL_API: undefined, OPENAI_BASE: undefined }, async () => {
      await assert.rejects(runText("hola", {}, {}, 5000, () => {}), /Ollama \/api\/chat: respuesta cortada/);
    });
  } finally {
    await server.close();
  }
});

test("runText en vivo con Ollama: un servidor que se cuelga a mitad falla por plazo (reintentable), igual que sin stream", async () => {
  const server = await startStallingServer((res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.write(`${JSON.stringify({ message: { content: "Hola" }, done: false })}\n`);
  });
  try {
    await withEnv({ OLLAMA_BASE_URL: `http://127.0.0.1:${server.port}`, TEXT_MODEL_API: undefined, OPENAI_BASE: undefined }, async () => {
      const error = await runText("hola", {}, {}, 1500, () => {}).then(() => assert.fail("no puede ser exito"), (caught: unknown) => caught);
      assert.equal((error as Error).name, "TimeoutError");
      assert.equal(decideJobFailure({ error, deliveryCount: 1, maxAttempts: 3 }).settlement, "abandon");
    });
  } finally {
    await server.close();
  }
});

test("worker: despues de que el backend dejo de esperar no se publican parciales; la generacion y el resultado siguen", async () => {
  const clock = manualClock();
  const messages: ServiceBusMessage[] = [];
  const logged: string[] = [];
  const done = runTextJobWithPartials({
    jobId: "job-plazo",
    sender: { sendMessages: async (message) => { messages.push(message); } },
    stopPartialsAt: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { info: (event) => logged.push(event), warn: (event) => logged.push(event) },
    run: async (onText) => {
      onText("uno"); // t=0: sale enseguida
      await clock.advance(400);
      onText("uno dos"); // t=400: queda para los 500 ms
      await clock.advance(100); // t=500: sale
      await clock.advance(400);
      onText("uno dos tres"); // t=900: queda para los 1000 ms, que ya es el plazo: no sale
      await clock.advance(100);
      await clock.advance(300);
      onText("uno dos tres cuatro"); // t=1300: el backend ya no espera: ni se encola
      await clock.advance(2_000);
      return "uno dos tres cuatro";
    },
  });
  assert.equal(await done, "uno dos tres cuatro", "el texto completo vuelve igual (el resultado se manda como siempre)");
  const texts = messages.map((message) => JSON.parse(String(message.body)).partialText);
  assert.deepEqual(texts, ["uno", "uno dos"], "solo los de antes del plazo");
  assert.ok(logged.includes("queue.partial.expired"));
});

test("jobWaitDeadline: requestedAt (o la hora de la cola) mas el plazo; isJobStale usa la misma cuenta", () => {
  const requestedAt = "2026-11-01T10:00:00.000Z";
  const deadline = jobWaitDeadline({ requestedAt, timeoutMs: 120_000 });
  assert.equal(deadline, Date.parse(requestedAt) + 120_000);
  assert.equal(jobWaitDeadline({ enqueuedTimeUtc: new Date(requestedAt), timeoutMs: 120_000 }), deadline);
  assert.equal(jobWaitDeadline({ timeoutMs: 120_000 }), null);
  assert.equal(isJobStale({ requestedAt, timeoutMs: 120_000, now: deadline! }), false);
  assert.equal(isJobStale({ requestedAt, timeoutMs: 120_000, now: deadline! + 1 }), true);
});

test("parciales con el intento: el id y el cuerpo lo llevan; sin intento, como antes", () => {
  const withAttempt = buildPartialMessage({ jobId: "job-i", attempt: 2, seq: 3, partialText: "x" });
  assert.equal(withAttempt.messageId, "job-i:a2:p3");
  assert.equal(JSON.parse(String(withAttempt.body)).attempt, 2);
  const old = buildPartialMessage({ jobId: "job-i", seq: 3, partialText: "x" });
  assert.equal(old.messageId, "job-i:p3");
  assert.equal("attempt" in JSON.parse(String(old.body)), false);
  assert.equal(buildPartialMessage({ jobId: "job-i", attempt: 0, seq: 1, partialText: "x" }).messageId, "job-i:p1", "un intento invalido no va");
});

test("readPartialMessage: un intento mayor reinicia seq (restarted si ya se mostro algo); uno menor se ignora", () => {
  const read = (attempt: number | undefined, seq: number, lastSeq: number, lastAttempt: number) =>
    readPartialMessage({ body: buildPartialMessage({ jobId: "j", attempt, seq, partialText: `a${attempt}s${seq}` }).body }, { jobId: "j", lastSeq, lastAttempt });
  assert.deepEqual(read(1, 1, 0, 0), { ok: true, seq: 1, attempt: 1, text: "a1s1", restarted: false }, "el primero no es un reinicio");
  assert.deepEqual(read(2, 1, 5, 1), { ok: true, seq: 1, attempt: 2, text: "a2s1", restarted: true }, "el reintento en otro worker empieza en 1");
  assert.deepEqual(read(1, 9, 1, 2), { ok: false, reason: "intento_viejo" });
  assert.deepEqual(read(2, 1, 1, 2), { ok: false, reason: "repetido" });
  assert.deepEqual(read(undefined, 6, 5, 1), { ok: true, seq: 6, attempt: 1, text: "aundefineds6", restarted: false }, "sin intento (worker anterior): solo seq, como antes");
  assert.deepEqual(read(undefined, 5, 5, 1), { ok: false, reason: "repetido" });
});

test("backend: si el job se reintenta en otro worker, la prosa del intento fallido se reemplaza (no queda congelada)", async () => {
  const at = (attempt: number, seq: number, text: string) => buildPartialMessage({ jobId: "job-r", attempt, seq, partialText: text, sharedSecret: "secreto" });
  const { client } = fakeSessionClient([
    at(1, 1, "Primer intento"),
    at(1, 2, "Primer intento sigue"),
    at(1, 3, "Primer intento sigue mas"),
    at(2, 1, "Segundo"),
    at(1, 4, "Primer intento atrasado"),
    at(2, 2, "Segundo intento"),
    finalResult("job-r", "Segundo intento completo"),
  ]);
  const seen: Array<{ text: string; restarted: boolean }> = [];
  const result = await waitForQueueResult(client, "job-r", 5_000, silentLogger, {
    onPartial: (text, info) => seen.push({ text, restarted: info?.restarted === true }),
    resultsQueueName: "r",
    sharedSecret: "secreto",
  });
  assert.deepEqual(seen, [
    { text: "Primer intento", restarted: false },
    { text: "Primer intento sigue", restarted: false },
    { text: "Primer intento sigue mas", restarted: false },
    { text: "Segundo", restarted: true },
    { text: "Segundo intento", restarted: false },
  ]);
  assert.equal(result.outputText, "Segundo intento completo");
});

test("worker: los parciales llevan el intento (deliveryCount) del job", async () => {
  const messages: ServiceBusMessage[] = [];
  await runTextJobWithPartials({
    jobId: "job-a2",
    attempt: 2,
    sender: { sendMessages: async (message) => { messages.push(message); } },
    intervalMs: 0,
    run: async (onText) => {
      onText("hola");
      await new Promise((resolve) => setImmediate(resolve));
      return "hola";
    },
  });
  assert.equal(messages[0].messageId, "job-a2:a2:p1");
  assert.equal(JSON.parse(String(messages[0].body)).attempt, 2);
});
