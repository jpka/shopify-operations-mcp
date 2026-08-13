/**
 * Mock Shopify Admin API: fake GraphQL endpoint with a per-operation handler
 * registry and a call log. Every mutation/query is recorded so tests can assert
 * "preview made zero mutation calls" by inspecting the log.
 */
import type { GraphQLResponse } from "../../src/graphql/adminClient.js";

export interface GraphQLCall {
  query: string;
  variables: Record<string, unknown>;
  cost?: number;
}

export interface MutationCall extends GraphQLCall {
  mutation: string;
}

export interface QueryCall extends GraphQLCall {
  queryName: string;
}

export type AnyCall = QueryCall | MutationCall;

/** Records every call made through the mock client. */
export class CallLog {
  private calls: AnyCall[] = [];

  record(call: AnyCall): void {
    this.calls.push(call);
  }

  clear(): void {
    this.calls = [];
  }

  /** Returns all mutation calls (queries that start with 'mutation' keyword). */
  mutations(): MutationCall[] {
    return this.calls.filter(
      (c): c is MutationCall => c.query.trimStart().startsWith("mutation"),
    );
  }

  /** Returns all query calls. */
  queries(): QueryCall[] {
    return this.calls.filter(
      (c): c is QueryCall => !c.query.trimStart().startsWith("mutation"),
    );
  }

  all(): AnyCall[] {
    return [...this.calls];
  }

  /** True if no calls of any kind were recorded. */
  isEmpty(): boolean {
    return this.calls.length === 0;
  }

  /** Returns the count of mutation calls only. */
  mutationCount(): number {
    return this.mutations().length;
  }
}

/** Extracts the operation name from a GraphQL query string. */
function extractQueryName(query: string): string {
  const match = query.match(/(?:query|mutation)\s+(\w+)/);
  return match?.[1] ?? "(anonymous)";
}

/** Handler for a specific GraphQL operation. */
type OperationHandler<TVariables, TData> = (
  variables: TVariables,
  callLog: CallLog,
) => TData;

/**
 * Registry mapping operation names to their handlers. Handlers receive the
 * variables and the call log, and return the response data.
 */
export class MockShopifyRegistry {
  private queryHandlers = new Map<
    string,
    OperationHandler<Record<string, unknown>, unknown>
  >();
  private mutationHandlers = new Map<
    string,
    OperationHandler<Record<string, unknown>, unknown>
  >();

  /**
   * Registers a query handler. The handler is called with variables and the
   * call log each time the query is invoked.
   */
  registerQuery<TVariables, TData>(
    operationName: string,
    handler: OperationHandler<TVariables, TData>,
  ): void {
    this.queryHandlers.set(operationName, handler as OperationHandler<Record<string, unknown>, unknown>);
  }

  /**
   * Registers a mutation handler. The handler is called with variables and the
   * call log each time the mutation is invoked.
   */
  registerMutation<TVariables, TData>(
    operationName: string,
    handler: OperationHandler<TVariables, TData>,
  ): void {
    this.mutationHandlers.set(
      operationName,
      handler as OperationHandler<Record<string, unknown>, unknown>,
    );
  }

  /** Returns true if a query handler is registered. */
  hasQuery(operationName: string): boolean {
    return this.queryHandlers.has(operationName);
  }

  /** Returns true if a mutation handler is registered. */
  hasMutation(operationName: string): boolean {
    return this.mutationHandlers.has(operationName);
  }

  /**
   * Invokes the appropriate handler based on the operation name extracted from
   * the query. Records the call in the log before invoking the handler.
   */
  invoke<TData>(
    query: string,
    variables: Record<string, unknown>,
    callLog: CallLog,
  ): GraphQLResponse<TData> {
    const queryName = extractQueryName(query);
    const isMutation = query.trimStart().startsWith("mutation");

    if (isMutation) {
      const handler = this.mutationHandlers.get(queryName);
      if (!handler) {
        callLog.record({ query, variables, mutation: queryName });
        return {
          data: null,
          errors: [
            {
              message: `No mock handler registered for mutation: ${queryName}`,
            },
          ],
        };
      }
      callLog.record({ query, variables, mutation: queryName });
      const data = handler(variables, callLog) as TData;
      return { data };
    } else {
      const handler = this.queryHandlers.get(queryName);
      if (!handler) {
        callLog.record({ query, variables, queryName });
        return {
          data: null,
          errors: [
            {
              message: `No mock handler registered for query: ${queryName}`,
            },
          ],
        };
      }
      callLog.record({ query, variables, queryName });
      const data = handler(variables, callLog) as TData;
      return { data };
    }
  }
}

/** Default empty response extensions used by mock responses. */
export const DEFAULT_EXTENSIONS = {
  cost: {
    requestedQueryCost: 10,
    actualQueryCost: 10,
    throttleStatus: {
      maximumAvailable: 1000,
      currentlyAvailable: 900,
      restoreRate: 50,
    },
  },
};

/** Creates a standard mock response with default cost extensions. */
export function mockResponse<T>(data: T): GraphQLResponse<T> & { extensions: typeof DEFAULT_EXTENSIONS } {
  return {
    data,
    extensions: DEFAULT_EXTENSIONS,
  };
}

/** Simulates a throttled response. */
export function throttledResponse<T>(): GraphQLResponse<T> {
  return {
    data: null,
    errors: [{ message: "Throttled" }],
  };
}

/** Simulates a user error response. */
export function userErrorResponse<T>(message: string): GraphQLResponse<T> {
  return {
    data: null,
    errors: [{ message }],
  };
}
