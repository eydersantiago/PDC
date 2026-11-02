
// ---- Reloj virtual: los temporizadores solo corren cuando la prueba avanza el tiempo ----

export class VirtualClock {
  now = Date.parse("2026-09-25T13:00:00.000Z");
  private seq = 0;
  private timers = new Map<number, { due: number; fn: (...args: unknown[]) => unknown; args: unknown[]; every: number }>();

  setTimeout = (fn: (...args: unknown[]) => unknown, ms?: number, ...args: unknown[]) => {
    const id = ++this.seq;
    this.timers.set(id, { due: this.now + Math.max(0, Number(ms) || 0), fn, args, every: 0 });
    return id;
  };

  setInterval = (fn: (...args: unknown[]) => unknown, ms?: number, ...args: unknown[]) => {
    const id = ++this.seq;
    const every = Math.max(1, Number(ms) || 1);
    this.timers.set(id, { due: this.now + every, fn, args, every });
    return id;
  };

  clear = (id: unknown) => {
    this.timers.delete(Number(id));
  };

  async settle() {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  async step() {
    let nextId = 0;
    let next: { due: number; fn: (...args: unknown[]) => unknown; args: unknown[]; every: number } | undefined;
    for (const [id, timer] of this.timers) {
      if (!next || timer.due < next.due) {
        next = timer;
        nextId = id;
      }
    }
    if (!next) return false;
    this.now = Math.max(this.now, next.due);
    if (next.every) next.due = this.now + next.every;
    else this.timers.delete(nextId);
    try {
      await next.fn(...next.args);
    } catch {
      // Un temporizador que falla no detiene la simulacion (igual que en el navegador).
    }
    await this.settle();
    return true;
  }

  async until(predicate: () => boolean, maxSteps = 4000) {
    await this.settle();
    for (let i = 0; i < maxSteps; i++) {
      if (predicate()) return true;
      if (!(await this.step())) break;
    }
    return predicate();
  }
}
