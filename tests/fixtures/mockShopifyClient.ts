/**
 * Mock AdminClient factory: produces an AdminClient that routes GraphQL calls
 * through a MockShopifyRegistry instead of the network. The call log is shared
 * so tests can assert "preview made zero mutation calls."
 */
import { AdminClient } from "../../src/graphql/adminClient.js";
import type { ShopifyConfig } from "../../src/config.js";
import type { AdminClientOptions } from "../../src/graphql/adminClient.js";
import {
  CallLog,
  MockShopifyRegistry,
  type AnyCall,
} from "./mockShopifyApi.js";

export interface MockAdminClient {
  client: AdminClient;
  registry: MockShopifyRegistry;
  callLog: CallLog;
}

function shopifyConfig(): ShopifyConfig {
  return {
    storeDomain: "test.myshopify.com",
    apiVersion: "2026-04",
    adminToken: "shpat_mock_token",
  };
}

/**
 * Creates a mock AdminClient backed by a MockShopifyRegistry. The registry
 * starts empty — register handlers before invoking operations. The call log
 * is shared between the registry and the returned reference for easy inspection.
 */
export function createMockAdminClient(
  options: AdminClientOptions = {},
): MockAdminClient {
  const callLog = new CallLog();
  const registry = new MockShopifyRegistry();

  const mockFetch = async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    // This will be called by AdminClient.graphql() — we parse the request
    // and delegate to the registry. The actual invocation happens in the
    // wrapped graphql call below.
    throw new Error(
      "MockAdminClient.graphql() must be called directly, not through fetch. " +
        "Use createMockAdminClient() and call client.graphql() directly.",
    );
  };

  const client = new AdminClient(shopifyConfig(), {
    ...options,
    fetch: mockFetch,
  });

  // Replace the graphql method to route through the registry
  const originalGraphql = client.graphql.bind(client);
  (client as unknown as { graphql: typeof originalGraphql }).graphql =
    async function <TData = Record<string, unknown>>(
      op: Parameters<typeof originalGraphql>[0],
    ): Promise<TData> {
      const response = registry.invoke<TData>(op.query, op.variables ?? {}, callLog);
      if (response.errors && response.errors.length > 0) {
        const error = response.errors[0]!;
        throw Object.assign(new Error(error.message), {
          code: "SHOPIFY_API_ERROR",
          hint: "Mock error",
          status: null,
          retries: 0,
        });
      }
      return response.data as TData;
    };

  return { client, registry, callLog };
}

/** Returns all calls matching a given mutation or query name. */
export function callsOf(log: CallLog, name: string): AnyCall[] {
  return log.all().filter((c) => {
    if ("mutation" in c) return c.mutation === name;
    return c.queryName === name;
  });
}

/** Returns the number of calls matching a given mutation or query name. */
export function countCalls(log: CallLog, name: string): number {
  return callsOf(log, name).length;
}
