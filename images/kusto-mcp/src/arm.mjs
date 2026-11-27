// Azure Resource Manager: subscription lookup and Resource Graph queries for
// the control-plane cluster commands (kusto_cluster_list, kusto_cluster_get) and
// for resolving --cluster plus --subscription to a cluster URI.
import { fetchWithRetry, readJson } from "./http.mjs";
import { isGuid } from "./auth.mjs";
import { ArgumentError, escapeKqlString, ValidationError } from "./kql.mjs";

/** .NET KeyNotFoundException. kind says what was missing. */
export class NotFoundError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "KeyNotFoundException";
    this.status = 404;
    this.kind = kind;
  }
}

const RESOURCE_GRAPH_API = "2024-04-01";
const SUBSCRIPTIONS_API = "2022-12-01";
const RESOURCE_GROUPS_API = "2021-04-01";
const CACHE_MS = 10 * 60_000;
const ARM_ERROR = "RequestFailedException";

// azure-mcp SubscriptionResolver placeholders, treated as "use the default".
const PLACEHOLDERS = new Set([
  "<subscription>", "<subscription-id>", "<subscription-name>", "<subscription-id-or-name>", "<subscriptionid>",
  "<subscription_id>", "<subscription_name>", "<sub-id>", "<your-subscription-id>", "your-subscription-id",
  "subscription_id", "{subscription}", "{subscriptionid}", "{subscription-id}", "{subscription_id}",
  "{subscription-name}", "{subscription-name-or-id}", "your subscription", "your subscription id", "default",
  "<default>", "{default}", "default-sub", "<default-sub>", "{default-sub}", "default_sub", "default_subscription",
]);

/** azure-mcp ResolveSubscription: trim quotes; a placeholder or empty value means the default. */
export function resolveSubscriptionOption(value, fallback) {
  const trimmed = typeof value === "string" ? value.replace(/^["']+|["']+$/g, "") : value;
  if (trimmed && !PLACEHOLDERS.has(String(trimmed).toLowerCase())) return trimmed;
  return fallback || trimmed || undefined;
}

export function parseResourceId(id) {
  const parts = String(id ?? "").split("/");
  const find = (name) => {
    const index = parts.findIndex((part) => part.toLowerCase() === name);
    return index >= 0 ? parts[index + 1] : undefined;
  };
  return { subscriptionId: find("subscriptions"), resourceGroup: find("resourcegroups") };
}

// .NET Uri.ToString() adds "/" to an origin-only URI; azure-mcp returns it.
const dotnetUri = (value) => {
  if (!value) return null;
  try {
    const uri = new URL(value);
    return uri.pathname === "/" && !value.endsWith("/") ? `${value}/` : value;
  } catch {
    return value;
  }
};

/** azure-mcp KustoService.ConvertToClusterModel. */
export function toClusterModel(item) {
  if (!item?.id) throw new Error("Resource ID is missing");
  const { subscriptionId, resourceGroup } = parseResourceId(item.id);
  const p = item.properties ?? {};
  return {
    name: item.name ?? "Unknown",
    location: item.location ?? null,
    resourceGroup: resourceGroup ?? null,
    subscription: subscriptionId ?? null,
    sku: item.sku?.name ?? null,
    zones: Array.isArray(item.zones) ? item.zones.join(",") : "",
    identity: item.identity?.type ?? null,
    etag: item.etag ?? null,
    state: p.state ?? null,
    provisioningState: p.provisioningState ?? null,
    clusterUri: dotnetUri(p.uri),
    dataIngestionUri: dotnetUri(p.dataIngestionUri),
    stateReason: p.stateReason ?? null,
    isStreamingIngestEnabled: p.enableStreamingIngest ?? false,
    engineType: p.engineType ?? null,
    isAutoStopEnabled: p.enableAutoStop ?? false,
  };
}

/** azure-mcp ValidateAdditionalFilter: no pipe in a filter value. */
function checkFilterValue(value) {
  if (value && String(value).includes("|")) {
    throw new ArgumentError("additionalFilter must not contain the pipe operator '|' to prevent KQL injection.", "additionalFilter");
  }
}

export class ArmClient {
  constructor({ tokens, fetch: fetchImpl = globalThis.fetch, endpoint = "https://management.azure.com", defaultSubscription, timeoutMs = 60_000, retries = 3, now = Date.now }) {
    this.tokens = tokens;
    this.fetch = fetchImpl;
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.defaultSubscription = defaultSubscription;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.now = now;
    this.subscriptions = new Map();
    this.clusters = new Map();
  }

  async #request(method, path, tenant, body, signal) {
    const token = await this.tokens.token(`${this.endpoint}/.default`, tenant);
    const response = await fetchWithRetry(this.fetch, path.startsWith("http") ? path : `${this.endpoint}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, { timeoutMs: this.timeoutMs, retries: this.retries, signal });
    return { response, path };
  }

  async #json(method, path, tenant, body, signal) {
    const { response } = await this.#request(method, path, tenant, body, signal);
    return readJson(response, `${method} ${new URL(path, this.endpoint).pathname}`, ARM_ERROR);
  }

  /** A subscription GUID, or a display name resolved through the subscriptions list. */
  async subscriptionId(value, tenant, signal) {
    const subscription = resolveSubscriptionOption(value, this.defaultSubscription);
    if (!subscription) throw new ValidationError("Missing Required options: --subscription");
    if (isGuid(subscription)) return subscription;
    const key = `${tenant ?? ""}\n${subscription.toLowerCase()}`;
    const cached = this.subscriptions.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.id;
    let next = `/subscriptions?api-version=${SUBSCRIPTIONS_API}`;
    let match;
    for (let page = 0; next && !match && page < 20; page++) {
      if (next.startsWith("http") && !next.startsWith(`${this.endpoint}/`)) break; // never follow nextLink off ARM
      const list = await this.#json("GET", next, tenant, undefined, signal);
      match = (list?.value ?? []).find((item) => item.displayName?.toLowerCase() === subscription.toLowerCase());
      next = list?.nextLink;
    }
    if (!match) throw new NotFoundError(`Subscription '${subscription}' not found or not accessible.`, "subscription");
    this.subscriptions.set(key, { id: match.subscriptionId, expiresAt: this.now() + CACHE_MS });
    return match.subscriptionId;
  }

  async resourceGraph(query, subscriptionId, tenant, signal) {
    const result = await this.#json("POST", `/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API}`, tenant, {
      subscriptions: [subscriptionId],
      query,
      options: { resultFormat: "objectArray" },
    }, signal);
    const truncated = result?.resultTruncated === true || String(result?.resultTruncated).toLowerCase() === "true";
    return { data: Array.isArray(result?.data) ? result.data : [], truncated };
  }

  static clusterQuery({ resourceGroup, name, limit = 50 } = {}) {
    checkFilterValue(name);
    let query = `resources | where type =~ '${escapeKqlString("Microsoft.Kusto/clusters")}'`;
    if (resourceGroup) query += ` and resourceGroup =~ '${escapeKqlString(resourceGroup)}'`;
    if (name) query += ` and name =~ '${escapeKqlString(name)}'`;
    return `${query} | limit ${limit}`;
  }

  async #resourceGroupExists(subscriptionId, resourceGroup, tenant, signal) {
    const { response } = await this.#request("GET", `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroup)}?api-version=${RESOURCE_GROUPS_API}`, tenant, undefined, signal);
    if (response.status === 404) {
      await response.arrayBuffer().catch(() => {});
      return false;
    }
    await readJson(response, "GET resource group", ARM_ERROR);
    return true;
  }

  async listClusters({ subscription, resourceGroup, tenant, signal }) {
    const subscriptionId = await this.subscriptionId(subscription, tenant, signal);
    const { data, truncated } = await this.resourceGraph(ArmClient.clusterQuery({ resourceGroup }), subscriptionId, tenant, signal);
    if (!data.length && resourceGroup && !(await this.#resourceGroupExists(subscriptionId, resourceGroup, tenant, signal))) {
      throw new NotFoundError(`Resource group '${resourceGroup}' does not exist in subscription '${subscriptionId}'`, "resourceGroup");
    }
    return { clusters: data.map((item) => toClusterModel(item).name), areResultsTruncated: truncated };
  }

  async getCluster({ subscription, cluster, tenant, signal }) {
    const subscriptionId = await this.subscriptionId(subscription, tenant, signal);
    const { data } = await this.resourceGraph(ArmClient.clusterQuery({ name: cluster, limit: 1 }), subscriptionId, tenant, signal);
    if (!data.length) throw new NotFoundError(`Kusto cluster '${cluster}' not found for subscription '${subscriptionId}'.`, "cluster");
    return toClusterModel(data[0]);
  }

  /** Resolve a cluster name in a subscription to its data-plane URI (cached). */
  async clusterUri({ subscription, cluster, tenant, signal }) {
    const subscriptionId = await this.subscriptionId(subscription, tenant, signal);
    const key = `${tenant ?? ""}\n${subscriptionId}\n${cluster.toLowerCase()}`;
    const cached = this.clusters.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.uri;
    const model = await this.getCluster({ subscription: subscriptionId, cluster, tenant, signal });
    if (!model.clusterUri) throw new Error(`Could not retrieve ClusterUri for cluster '${cluster}'`);
    this.clusters.set(key, { uri: model.clusterUri, expiresAt: this.now() + CACHE_MS });
    return model.clusterUri;
  }
}
