/**
 * Runs tasks with a hard cap on how many go at once.
 *
 * Without this, dropping ten links in one message fires ten pipelines simultaneously and
 * trips the tightest quota in the chain. Gemini's free tier sits around 10 requests per
 * minute, below Groq's 20, so it is what sets the ceiling. A pipeline takes 20-40 seconds,
 * which means a small concurrency keeps us comfortably under the limit without idling.
 */
export class Queue {
  #running = 0;
  #waiting: (() => void)[] = [];

  constructor(private readonly concurrency: number) {}

  /** Tasks queued or in flight, so callers can tell someone where they stand. */
  get depth(): number {
    return this.#running + this.#waiting.length;
  }

  async add<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running >= this.concurrency) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#running++;
    try {
      return await task();
    } finally {
      this.#running--;
      this.#waiting.shift()?.();
    }
  }
}
