/* eslint-disable functional/immutable-data, functional/no-let */
// Global limit on simultaneous requests to Google. Bursts of parallel requests
// (e.g. an assistant firing several searches at once, plus searches finishing
// in the background) are rejected or throttled by Google far more often.
// Mutable state is confined to this module.

import { config } from "./config.js";

let active = 0;
const waiting: Array<() => void> = [];

const acquire = (): Promise<void> => {
  if (active < config.retry.maxConcurrentRequests) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      active += 1;
      resolve();
    });
  });
};

const release = (): void => {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
};

export const withRequestSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
};
