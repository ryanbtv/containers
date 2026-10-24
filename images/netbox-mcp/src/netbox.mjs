// NetBox REST client: concurrency limit, timeouts, bounded retries, redaction.
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const RETRY_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN"]);
// Only methods that cannot change state are retried. POST/PUT/PATCH/DELETE are
// never retried: a 502 can arrive after NetBox committed the change, and a
// repeated bulk DELETE would fail on ids that are already gone. Read-only
// POSTs (GraphQL, render-config) opt in per call with { retry: true }.
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);
// Transport failures before the request reached NetBox. Anything else on a
// write leaves its outcome unknown.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

export class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.waiting = [];
  }

  async run(task) {
    if (this.active >= this.max) await new Promise((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export function makeRedactor(...secrets) {
  const values = secrets.filter((secret) => typeof secret === "string" && secret.length >= 4);
  return (input) => {
    let text = String(input);
    for (const secret of values) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/\bnbt_[A-Za-z0-9._-]+/g, "nbt_[REDACTED]")
      .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._-]{8,}/g, "$1 [REDACTED]");
  };
}

export class NetBoxError extends Error {
  constructor(message, { status, method, path, body, requestId, startedAt, outcomeUnknown = false } = {}) {
    super(message);
    this.name = "NetBoxError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
    this.requestId = requestId;
    this.startedAt = startedAt;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function unknownOutcomeNote(startedAt) {
  return ` The write may have been applied: NetBox can finish it after the client gives up. Do not repeat it blindly. Verify with get_changelog since="${startedAt}" (the request start, by this host's clock).`;
}

// NetBox validation bodies are {field: [msgs]} or, for bulk, [{...}, {}].
export function summarizeErrorBody(body, max = 1500) {
  if (body === undefined || body === null || body === "") return "";
  if (typeof body === "string") {
    const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  let value = body;
  if (Array.isArray(body)) {
    const indexed = {};
    body.forEach((entry, index) => {
      if (entry && (typeof entry !== "object" || Object.keys(entry).length)) indexed[`[${index}]`] = entry;
    });
    value = indexed;
  } else if (typeof body.detail === "string" && Object.keys(body).length === 1) {
    value = body.detail;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function normalizeBaseUrl(input) {
  if (!input) return undefined;
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("NETBOX_URL must use http or https");
  if (url.username || url.password || url.search || url.hash) throw new Error("NETBOX_URL must not contain credentials, a query, or a fragment");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return url.href.replace(/\/+$/, "");
}

export function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      if (item === undefined) continue;
      search.append(key, item === null ? "null" : typeof item === "boolean" ? String(item) : String(item));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class NetBoxClient {
  constructor({
    url,
    token,
    maxConcurrency = 3,
    timeoutMs = 30_000,
    writeTimeoutMs = 120_000,
    retries = 3,
    retryBaseMs = 250,
    retryMaxMs = 3_000,
    maxBodyBytes = 64 * 1024 * 1024,
    fetchImpl = globalThis.fetch,
    log = () => {},
  } = {}) {
    this.baseUrl = normalizeBaseUrl(url);
    this.token = typeof token === "string" ? token.trim() : undefined;
    this.redact = makeRedactor(this.token);
    this.limiter = new Semaphore(maxConcurrency);
    this.timeoutMs = timeoutMs;
    this.writeTimeoutMs = writeTimeoutMs;
    this.retries = retries;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.maxBodyBytes = maxBodyBytes;
    this.fetch = fetchImpl;
    this.log = log;
    this.stats = { requests: 0, retries: 0 };
  }

  get authorization() {
    return this.token.startsWith("nbt_") ? `Bearer ${this.token}` : `Token ${this.token}`;
  }

  assertConfigured() {
    if (!this.baseUrl) throw new NetBoxError("NETBOX_URL is not set");
    if (!this.token) throw new NetBoxError("NETBOX_TOKEN (or NETBOX_TOKEN_FILE) is not set");
  }

  backoff(attempt, retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, this.retryMaxMs);
    const exponential = Math.min(this.retryBaseMs * 2 ** attempt, this.retryMaxMs);
    return Math.round(exponential / 2 + Math.random() * (exponential / 2));
  }

  /**
   * path is relative to the NetBox origin and must start with /api/ or be
   * /graphql/. Returns { status, data, requestId }.
   */
  async request(method, path, { query, body, retry } = {}) {
    this.assertConfigured();
    method = method.toUpperCase();
    if (typeof path !== "string" || !/^\/(api|graphql)\//.test(path) || path.includes("..") || /[?#\\]/.test(path)) {
      throw new NetBoxError(`refusing unexpected path ${JSON.stringify(path)}`);
    }
    const href = `${this.baseUrl}${path}${buildQuery(query)}`;
    const retryable = retry ?? IDEMPOTENT.has(method);
    // Reads and read-only POSTs use the read timeout. Writes get longer: a
    // bulk change can outlast 30 s, and a write cannot be retried.
    const timeoutMs = retryable ? this.timeoutMs : this.writeTimeoutMs;
    let attempt = 0;
    while (true) {
      let outcome;
      let startedAt;
      try {
        outcome = await this.limiter.run(() => {
          startedAt = new Date().toISOString();
          return this.once(method, path, href, body, timeoutMs);
        });
      } catch (error) {
        const code = error.cause?.code ?? error.code;
        const transient = error.name === "TimeoutError" || RETRY_CODES.has(code) || /fetch failed|socket hang up/i.test(error.message);
        if (retryable && transient && attempt < this.retries) {
          this.stats.retries += 1;
          await sleep(this.backoff(attempt));
          attempt += 1;
          continue;
        }
        if (error instanceof NetBoxError) throw error;
        const reason = error.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : `${code ? `${code}: ` : ""}${error.message}`;
        const outcomeUnknown = !retryable && startedAt !== undefined && !NOT_SENT_CODES.has(code);
        const note = outcomeUnknown ? unknownOutcomeNote(startedAt) : "";
        throw new NetBoxError(this.redact(`NetBox ${method} ${path} failed: ${reason}.${note}`), { method, path, startedAt, outcomeUnknown });
      }
      const { response, data, text } = outcome;
      const requestId = response.headers.get("x-request-id") ?? undefined;
      if (RETRY_STATUS.has(response.status) && retryable && attempt < this.retries) {
        this.stats.retries += 1;
        await sleep(this.backoff(attempt, response.headers.get("retry-after")));
        attempt += 1;
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        throw new NetBoxError(`NetBox ${method} ${path} returned redirect ${response.status}; check NETBOX_URL (scheme, host, trailing path)`, {
          status: response.status, method, path, requestId,
        });
      }
      if (!response.ok) {
        const summary = this.redact(summarizeErrorBody(data ?? text));
        let message = `NetBox ${method} ${path} → HTTP ${response.status}${summary ? `: ${summary}` : ""}`;
        const outcomeUnknown = RETRY_STATUS.has(response.status) && !retryable;
        if (outcomeUnknown) message += ` (not retried).${unknownOutcomeNote(startedAt)}`;
        throw new NetBoxError(message, { status: response.status, method, path, body: data, requestId, startedAt, outcomeUnknown });
      }
      return { status: response.status, data, requestId, startedAt };
    }
  }

  async once(method, path, href, body, timeoutMs = this.timeoutMs) {
    this.stats.requests += 1;
    const started = Date.now();
    const response = await this.fetch(href, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
        Authorization: this.authorization,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await readBounded(response, this.maxBodyBytes);
    let data;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    this.log(`${method} ${path} ${response.status} ${Date.now() - started}ms`);
    return { response, data, text };
  }

  get(path, query) {
    return this.request("GET", path, { query });
  }
}
