import { describe, it, expect } from "vitest";
import { withRequestSlot } from "../src/lib/limiter.js";
import { config } from "../src/lib/config.js";

describe("withRequestSlot", () => {
  it("never runs more than maxConcurrentRequests at once, and runs everything", async () => {
    let running = 0;
    let peak = 0;
    const task = (ms: number) =>
      withRequestSlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, ms));
        running -= 1;
        return ms;
      });
    const results = await Promise.all([30, 10, 20, 10, 5].map(task));
    expect(results).toEqual([30, 10, 20, 10, 5]);
    expect(peak).toBe(config.retry.maxConcurrentRequests);
  });

  it("frees the slot when a task throws", async () => {
    await expect(withRequestSlot(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const results = await Promise.all([1, 2, 3].map((n) => withRequestSlot(async () => n)));
    expect(results).toEqual([1, 2, 3]);
  });
});
