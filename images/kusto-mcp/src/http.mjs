// Shared HTTP plumbing: an error type, a concurrency limiter, and fetch with
// timeouts, cancellation, and bounded retries for idempotent requests.

export class HttpError extends Error {
  constructor(message, { status, code, requestId, body, name = "HttpRequestException", source } = {}) {
    super(message);
    this.name = name;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
    this.source = source;
  }
}

export class Limiter {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }

  async run(task) {
    if (this.active >= this.max) await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

// Throttling and "temporarily unavailable" only. A gateway 502/504 or a
// timeout may mean the query ran to completion; repeating it doubles the cost.
const RETRY_STATUS = new Set([429, 503]);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

function retryDelay(attempt, response) {
  const header = response?.headers?.get?.("retry-after");
  const seconds = Number(header);
  if (header !== null && header !== undefined && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const base = Math.min(250 * 2 ** attempt, 4_000);
  return base / 2 + Math.random() * (base / 2);
}

async function backoff(sleepImpl, ms, signal, host) {
  try {
    await sleepImpl(ms, signal);
  } catch {
    throw new HttpError(`Request to ${host} was cancelled`, { status: 499, name: "TaskCanceledException" });
  }
}

/** A signal that fires on the caller's signal or after timeoutMs. */
export function requestSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/**
 * fetch with a timeout and an optional caller signal. Redirects are refused, so
 * a request cannot leave the host it was validated for. When retries > 0, the
 * request is retried on 429, 503, and connection errors (not on timeouts).
 * Only pass retries for requests that are safe to repeat.
 */
export async function fetchWithRetry(fetchImpl, url, init, { timeoutMs = 30_000, retries = 0, signal, sleepImpl = sleep, describeHost = new URL(url).host } = {}) {
  let attempt = 0;
  for (;;) {
    let response;
    const requestAbort = requestSignal(timeoutMs, signal);
    try {
      response = await fetchImpl(url, { ...init, redirect: "error", signal: requestAbort });
    } catch (error) {
      if (signal?.aborted) throw new HttpError(`Request to ${describeHost} was cancelled`, { status: 499, name: "TaskCanceledException" });
      const timedOut = error.name === "TimeoutError" || requestAbort.reason?.name === "TimeoutError";
      if (!timedOut && attempt < retries) {
        await backoff(sleepImpl, retryDelay(attempt), signal, describeHost);
        attempt++;
        continue;
      }
      const reason = timedOut ? `timed out after ${timeoutMs} ms` : (error.cause?.code ?? error.cause?.message ?? error.message);
      throw new HttpError(`Request to ${describeHost} failed: ${reason}`, { status: timedOut ? 504 : 503 });
    }
    if (RETRY_STATUS.has(response.status) && attempt < retries) {
      await response.arrayBuffer().catch(() => {});
      await backoff(sleepImpl, retryDelay(attempt, response), signal, describeHost);
      attempt++;
      continue;
    }
    return response;
  }
}

/** Read a JSON body. Throws HttpError (with the given error name) on a non-2xx status. */
export async function readJson(response, describe, errorName = "HttpRequestException") {
  const text = await response.text();
  if (!response.ok) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const error = parsed?.error;
    const message = error?.["@message"] ?? error?.message ?? text.slice(0, 2000);
    throw new HttpError(`${describe} failed with status code ${response.status}: ${message}`, {
      name: errorName,
      status: response.status,
      code: error?.code,
      requestId: response.headers.get("x-ms-request-id") ?? response.headers.get("x-ms-correlation-request-id") ?? undefined,
      body: parsed ?? text.slice(0, 2000),
    });
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${describe} returned invalid JSON`, { status: 502, name: errorName });
  }
}
