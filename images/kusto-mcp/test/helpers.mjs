import { ArmClient } from "../src/arm.mjs";
import { TokenProvider } from "../src/auth.mjs";
import { KustoClient } from "../src/kusto.mjs";
import { Tools } from "../src/tools.mjs";
import { CLIENT_ID, CLIENT_SECRET, SUBSCRIPTION, TENANT } from "./fake-azure.mjs";

export function makeTools(fake, { config = {}, mode = "both", kusto = {} } = {}) {
  const tokens = new TokenProvider({ tenantId: TENANT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, authorityHost: fake.url });
  const client = new KustoClient({ tokens, version: "test", retries: 2, extraHosts: ["127.0.0.1"], allowHttp: true, ...kusto });
  const arm = new ArmClient({ tokens, endpoint: fake.url, defaultSubscription: SUBSCRIPTION, retries: 2 });
  const fullConfig = {
    enableWrites: false,
    queryReadOnly: true,
    readOnlyHardline: false,
    defaultSubscription: SUBSCRIPTION,
    maxV2QueryLength: 65_536,
    maxIngestBytes: 4 * 1024 * 1024,
    ...config,
  };
  return new Tools({ kusto: client, arm, config: fullConfig, mode });
}

/** Parse the azure-mcp envelope out of a CallToolResult. */
export function envelope(result) {
  return JSON.parse(result.content[0].text);
}
