// Idempotencia de peticiones caras (A12.12): si el cliente repite una peticion con la misma
// cabecera Idempotency-Key, se responde lo mismo sin volver a llamar al modelo ni a sumar el
// cupo de pistas. Vive en memoria, como el relay y los limitadores (una sola instancia del
// App Service); un reinicio solo pierde la ventana de repeticion.

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Clave valida de la cabecera Idempotency-Key, o "" si no viene o no tiene forma de clave. */
export function readIdempotencyKey(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return KEY_PATTERN.test(text) ? text : "";
}

type Entry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

export type IdempotencyCacheOptions = {
  /** Cuanto se recuerda una respuesta (por defecto 10 min). */
  ttlMs?: number;
  /** Tope de claves en memoria; al pasarlo se descartan las mas viejas. */
  maxEntries?: number;
  now?: () => number;
};

export function createIdempotencyCache<T>(options: IdempotencyCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const maxEntries = Math.max(1, options.maxEntries ?? 500);
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<T>>();

  function prune() {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    /**
     * Corre work una sola vez por clave: una repeticion mientras corre espera el mismo
     * resultado, y una posterior lo recibe de memoria (reused: true). Si work falla, la clave
     * se olvida para que el cliente pueda reintentar.
     */
    run(key: string, work: () => Promise<T>): { promise: Promise<T>; reused: boolean } {
      prune();
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now()) {
        return { promise: existing.promise, reused: true };
      }

      const promise = work();
      entries.set(key, { promise, expiresAt: now() + ttlMs });
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
      });
      prune();
      return { promise, reused: false };
    },
    size() {
      prune();
      return entries.size;
    },
  };
}
