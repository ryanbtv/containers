// Microsoft Entra ID client-credentials tokens with a per-(tenant, scope) cache.

export class AuthError extends Error {
  constructor(message, { status = 401, code, correlationId } = {}) {
    super(message);
    this.name = "MsalServiceException";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (value) => typeof value === "string" && GUID.test(value);

export class TokenProvider {
  /**
   * @param {object} options
   * @param {string} options.tenantId default tenant
   * @param {string} options.clientId
   * @param {string} options.clientSecret
   * @param {string} [options.authorityHost] e.g. https://login.microsoftonline.com
   * @param {typeof fetch} [options.fetch]
   * @param {number} [options.timeoutMs]
   * @param {() => number} [options.now]
   */
  constructor({ tenantId, clientId, clientSecret, authorityHost = "https://login.microsoftonline.com", fetch: fetchImpl = globalThis.fetch, timeoutMs = 30_000, now = Date.now }) {
    this.tenantId = tenantId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.authorityHost = authorityHost.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.cache = new Map();
  }

  get configured() {
    return Boolean(this.tenantId && this.clientId && this.clientSecret);
  }

  /** Returns a bearer token for scope in tenant (default tenant when omitted). */
  async token(scope, tenant) {
    if (!this.configured) {
      throw new AuthError("Azure credentials are not configured. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET (or AZURE_CLIENT_SECRET_FILE).", { status: 401 });
    }
    const tenantId = tenant || this.tenantId;
    if (!isGuid(tenantId) && !/^[A-Za-z0-9.-]+$/.test(tenantId)) {
      throw new AuthError(`Invalid tenant '${tenantId}'.`, { status: 400 });
    }
    const key = `${tenantId}\n${scope}`;
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.promise) return cached.promise;
      if (cached.refreshAt > this.now()) return cached.token;
    }
    const promise = this.#acquire(tenantId, scope)
      .then(({ token, expiresAt, lifetime }) => {
        // Refresh 5 minutes early, or halfway through a shorter lifetime.
        this.cache.set(key, { token, refreshAt: expiresAt - Math.min(300_000, lifetime / 2) });
        return token;
      })
      .catch((error) => {
        this.cache.delete(key);
        throw error;
      });
    this.cache.set(key, { promise });
    return promise;
  }

  async #acquire(tenantId, scope) {
    const url = `${this.authorityHost}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope,
    });
    let response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AuthError(`Token request to ${this.authorityHost} failed: ${error.cause?.code ?? error.name}`, { status: 503 });
    }
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    if (!response.ok || typeof json.access_token !== "string") {
      const detail = (json.error_description ?? text).split(/\r?\n/)[0].slice(0, 400);
      throw new AuthError(`Token request failed (${response.status} ${json.error ?? ""}): ${detail}`.trim(), {
        status: response.status >= 400 ? response.status : 401,
        code: json.error,
        correlationId: json.correlation_id,
      });
    }
    const lifetime = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 3_600_000;
    return { token: json.access_token, expiresAt: this.now() + lifetime, lifetime };
  }
}
