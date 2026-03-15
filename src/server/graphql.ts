import {
  createGraphqlSchema,
} from "../graphql/schema";
import type {
  GraphqlRequestContext,
  GraphqlSchemaDependencies,
} from "../graphql/types";
import { GRAPHQL_MANAGER_SESSION_HEADER } from "../graphql/transport";
import { stripAmbientManagerExecutionContext } from "../workflow/manager-session-store";

interface GraphqlRequestEnvelope {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly operationName?: string;
}

interface GraphqlErrorEntry {
  readonly message: string;
}

interface GraphqlExecutionResult {
  readonly data?: unknown;
  readonly errors?: readonly GraphqlErrorEntry[];
}

type GraphqlOperationType = "query" | "mutation";

type GraphqlValueNode =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "list"; readonly items: readonly GraphqlValueNode[] }
  | {
      readonly kind: "object";
      readonly fields: Readonly<Record<string, GraphqlValueNode>>;
    };

interface GraphqlFieldNode {
  readonly name: string;
  readonly alias?: string;
  readonly arguments: Readonly<Record<string, GraphqlValueNode>>;
  readonly selectionSet?: readonly GraphqlFieldNode[];
}

interface GraphqlOperationNode {
  readonly type: GraphqlOperationType;
  readonly name?: string;
  readonly selectionSet: readonly GraphqlFieldNode[];
}

interface GraphqlToken {
  readonly kind: "name" | "string" | "number" | "punct";
  readonly value: string;
  readonly position: number;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function graphqlErrorResponse(
  message: string,
  status = 200,
  data: unknown = null,
): Response {
  return jsonResponse(
    {
      data,
      errors: [{ message }],
    } satisfies GraphqlExecutionResult,
    status,
  );
}

function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null) {
    return undefined;
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match === null) {
    return undefined;
  }
  const token = match[1]?.trim();
  return token !== undefined && token.length > 0 ? token : undefined;
}

function readManagerSessionId(request: Request): string | undefined {
  const value = request.headers.get(GRAPHQL_MANAGER_SESSION_HEADER);
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeVariables(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GraphQL variables must be a JSON object when provided");
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseGraphqlRequestEnvelope(value: unknown): GraphqlRequestEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GraphQL request body must be a JSON object");
  }

  const body = value as Readonly<Record<string, unknown>>;
  const query = typeof body["query"] === "string" ? body["query"].trim() : "";
  if (query.length === 0) {
    throw new Error("GraphQL request body must include a non-empty query string");
  }

  const operationName =
    typeof body["operationName"] === "string" &&
    body["operationName"].trim().length > 0
      ? body["operationName"].trim()
      : undefined;

  return {
    query,
    variables: normalizeVariables(body["variables"]),
    ...(operationName === undefined ? {} : { operationName }),
  };
}

function tokenizeGraphql(document: string): readonly GraphqlToken[] {
  const tokens: GraphqlToken[] = [];
  let index = 0;

  while (index < document.length) {
    const current = document[index];
    if (current === undefined) {
      break;
    }

    if (/\s/.test(current) || current === ",") {
      index += 1;
      continue;
    }

    if (current === "#") {
      index += 1;
      while (index < document.length && document[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if ("{}():[]!=$".includes(current)) {
      tokens.push({ kind: "punct", value: current, position: index });
      index += 1;
      continue;
    }

    if (current === '"') {
      let cursor = index + 1;
      let escaped = false;
      while (cursor < document.length) {
        const value = document[cursor];
        if (value === undefined) {
          break;
        }
        if (escaped) {
          escaped = false;
          cursor += 1;
          continue;
        }
        if (value === "\\") {
          escaped = true;
          cursor += 1;
          continue;
        }
        if (value === '"') {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (document[cursor - 1] !== '"') {
        throw new Error(`unterminated GraphQL string at position ${String(index)}`);
      }
      const raw = document.slice(index, cursor);
      tokens.push({
        kind: "string",
        value: JSON.parse(raw) as string,
        position: index,
      });
      index = cursor;
      continue;
    }

    const numberMatch = document
      .slice(index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (numberMatch?.[0] !== undefined) {
      tokens.push({
        kind: "number",
        value: numberMatch[0],
        position: index,
      });
      index += numberMatch[0].length;
      continue;
    }

    const nameMatch = document.slice(index).match(/^[_A-Za-z][_0-9A-Za-z]*/);
    if (nameMatch?.[0] !== undefined) {
      tokens.push({
        kind: "name",
        value: nameMatch[0],
        position: index,
      });
      index += nameMatch[0].length;
      continue;
    }

    throw new Error(
      `unexpected GraphQL token '${current}' at position ${String(index)}`,
    );
  }

  return tokens;
}

class GraphqlParser {
  private readonly tokens: readonly GraphqlToken[];

  private cursor = 0;

  constructor(tokens: readonly GraphqlToken[]) {
    this.tokens = tokens;
  }

  parseDocument(): GraphqlOperationNode {
    if (this.peekPunct("{")) {
      return {
        type: "query",
        selectionSet: this.parseSelectionSet(),
      };
    }

    const operationToken = this.expectName(
      "GraphQL document must start with query, mutation, or a selection set",
    );
    if (
      operationToken.value !== "query" &&
      operationToken.value !== "mutation"
    ) {
      throw new Error(
        `unsupported GraphQL operation '${operationToken.value}'; only query and mutation are implemented`,
      );
    }

    const operationType = operationToken.value;
    let operationName: string | undefined;
    if (this.peekName()) {
      operationName = this.expectName().value;
    }
    if (this.peekPunct("(")) {
      this.parseVariableDefinitions();
    }

    const operation: GraphqlOperationNode = {
      type: operationType,
      ...(operationName === undefined ? {} : { name: operationName }),
      selectionSet: this.parseSelectionSet(),
    };

    if (!this.isEof()) {
      throw new Error("only one GraphQL operation per request is supported");
    }

    return operation;
  }

  private parseVariableDefinitions(): void {
    this.expectPunct("(");
    while (!this.peekPunct(")")) {
      this.expectPunct("$");
      this.expectName("expected variable name");
      this.expectPunct(":");
      this.parseTypeReference();
      if (this.peekPunct("=")) {
        this.expectPunct("=");
        this.parseValue();
      }
    }
    this.expectPunct(")");
  }

  private parseTypeReference(): void {
    if (this.peekPunct("[")) {
      this.expectPunct("[");
      this.parseTypeReference();
      this.expectPunct("]");
    } else {
      this.expectName("expected GraphQL type reference");
    }
    if (this.peekPunct("!")) {
      this.expectPunct("!");
    }
  }

  private parseSelectionSet(): readonly GraphqlFieldNode[] {
    this.expectPunct("{");
    const fields: GraphqlFieldNode[] = [];
    while (!this.peekPunct("}")) {
      fields.push(this.parseField());
    }
    this.expectPunct("}");
    return fields;
  }

  private parseField(): GraphqlFieldNode {
    const firstName = this.expectName("expected field name").value;
    let alias: string | undefined;
    let name = firstName;
    if (this.peekPunct(":")) {
      this.expectPunct(":");
      alias = firstName;
      name = this.expectName("expected field name after alias").value;
    }

    const argumentsNode = this.peekPunct("(")
      ? this.parseArguments()
      : {};
    const selectionSet = this.peekPunct("{")
      ? this.parseSelectionSet()
      : undefined;

    return {
      name,
      ...(alias === undefined ? {} : { alias }),
      arguments: argumentsNode,
      ...(selectionSet === undefined ? {} : { selectionSet }),
    };
  }

  private parseArguments(): Readonly<Record<string, GraphqlValueNode>> {
    this.expectPunct("(");
    const argumentsNode: Record<string, GraphqlValueNode> = {};
    while (!this.peekPunct(")")) {
      const name = this.expectName("expected argument name").value;
      this.expectPunct(":");
      argumentsNode[name] = this.parseValue();
    }
    this.expectPunct(")");
    return argumentsNode;
  }

  private parseValue(): GraphqlValueNode {
    if (this.peekPunct("$")) {
      this.expectPunct("$");
      return {
        kind: "variable",
        name: this.expectName("expected variable reference").value,
      };
    }

    const token = this.peek();
    if (token === undefined) {
      throw new Error("unexpected end of GraphQL input while parsing value");
    }

    if (token.kind === "string") {
      this.cursor += 1;
      return { kind: "literal", value: token.value };
    }

    if (token.kind === "number") {
      this.cursor += 1;
      return { kind: "literal", value: Number(token.value) };
    }

    if (token.kind === "name") {
      this.cursor += 1;
      if (token.value === "true") {
        return { kind: "literal", value: true };
      }
      if (token.value === "false") {
        return { kind: "literal", value: false };
      }
      if (token.value === "null") {
        return { kind: "literal", value: null };
      }
      return { kind: "literal", value: token.value };
    }

    if (token.kind === "punct" && token.value === "[") {
      this.expectPunct("[");
      const items: GraphqlValueNode[] = [];
      while (!this.peekPunct("]")) {
        items.push(this.parseValue());
      }
      this.expectPunct("]");
      return {
        kind: "list",
        items,
      };
    }

    if (token.kind === "punct" && token.value === "{") {
      this.expectPunct("{");
      const fields: Record<string, GraphqlValueNode> = {};
      while (!this.peekPunct("}")) {
        const fieldName = this.expectName("expected input object field").value;
        this.expectPunct(":");
        fields[fieldName] = this.parseValue();
      }
      this.expectPunct("}");
      return {
        kind: "object",
        fields,
      };
    }

    throw new Error(
      `unexpected token '${token.value}' while parsing GraphQL value`,
    );
  }

  private peek(): GraphqlToken | undefined {
    return this.tokens[this.cursor];
  }

  private peekName(): boolean {
    return this.peek()?.kind === "name";
  }

  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token?.kind === "punct" && token.value === value;
  }

  private expectName(message = "expected GraphQL name"): GraphqlToken {
    const token = this.peek();
    if (token?.kind !== "name") {
      throw new Error(message);
    }
    this.cursor += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.peek();
    if (token?.kind !== "punct" || token.value !== value) {
      throw new Error(`expected '${value}' in GraphQL document`);
    }
    this.cursor += 1;
  }

  private isEof(): boolean {
    return this.cursor >= this.tokens.length;
  }
}

function parseGraphqlOperation(
  document: string,
  operationName?: string,
): GraphqlOperationNode {
  const operation = new GraphqlParser(tokenizeGraphql(document)).parseDocument();
  if (
    operationName !== undefined &&
    operation.name !== undefined &&
    operation.name !== operationName
  ) {
    throw new Error(
      `requested operation '${operationName}' does not match document operation '${operation.name}'`,
    );
  }
  return operation;
}

function resolveValueNode(
  node: GraphqlValueNode,
  variables: Readonly<Record<string, unknown>>,
): unknown {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "variable":
      if (!Object.prototype.hasOwnProperty.call(variables, node.name)) {
        throw new Error(`GraphQL variable '$${node.name}' was not provided`);
      }
      return variables[node.name];
    case "list":
      return node.items.map((item) => resolveValueNode(item, variables));
    case "object": {
      const entries = Object.entries(node.fields).map(([key, value]) => [
        key,
        resolveValueNode(value, variables),
      ]);
      return Object.fromEntries(entries);
    }
  }
}

function normalizeRootResolverInput(
  args: Readonly<Record<string, unknown>>,
): unknown {
  if (Object.prototype.hasOwnProperty.call(args, "input")) {
    return args["input"];
  }
  return Object.keys(args).length === 0 ? {} : args;
}

function projectSelection(
  value: unknown,
  selectionSet: readonly GraphqlFieldNode[] | undefined,
): unknown {
  if (selectionSet === undefined || selectionSet.length === 0) {
    return value ?? null;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => projectSelection(entry, selectionSet));
  }
  if (typeof value !== "object") {
    return value;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const projected: Record<string, unknown> = {};
  for (const field of selectionSet) {
    if (Object.keys(field.arguments).length > 0) {
      throw new Error(
        `field '${field.name}' arguments are only supported at the operation root`,
      );
    }
    const outputKey = field.alias ?? field.name;
    projected[outputKey] = projectSelection(record[field.name], field.selectionSet);
  }
  return projected;
}

export async function executeGraphqlDocument(
  document: string,
  context: GraphqlRequestContext,
  options: {
    readonly variables?: Readonly<Record<string, unknown>>;
    readonly operationName?: string;
    readonly deps?: GraphqlSchemaDependencies;
  } = {},
): Promise<unknown> {
  const operation = parseGraphqlOperation(document, options.operationName);
  const variables = options.variables ?? {};
  const schema = createGraphqlSchema(options.deps);
  const rootObject = (
    operation.type === "mutation" ? schema.mutation : schema.query
  ) as unknown as Readonly<Record<string, unknown>>;

  const data: Record<string, unknown> = {};
  for (const field of operation.selectionSet) {
    const resolver = rootObject[field.name];
    if (typeof resolver !== "function") {
      throw new Error(
        `unknown GraphQL ${operation.type} field '${field.name}'`,
      );
    }

    const args = Object.fromEntries(
      Object.entries(field.arguments).map(([key, value]) => [
        key,
        resolveValueNode(value, variables),
      ]),
    );
    const resolved = await (
      resolver as (
        input: unknown,
        context?: GraphqlRequestContext,
      ) => Promise<unknown>
    )(normalizeRootResolverInput(args), context);
    data[field.alias ?? field.name] = projectSelection(
      resolved,
      field.selectionSet,
    );
  }

  return data;
}

export async function handleGraphqlRequest(
  request: Request,
  context: GraphqlRequestContext,
  deps: GraphqlSchemaDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return graphqlErrorResponse("GraphQL endpoint only supports POST", 405);
  }

  let parsedBody: GraphqlRequestEnvelope;
  try {
    parsedBody = parseGraphqlRequestEnvelope((await request.json()) as unknown);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return graphqlErrorResponse(message, 400);
  }

  try {
    const authToken = readBearerToken(request);
    const managerSessionId = readManagerSessionId(request);
    const {
      authToken: _ignoredAuthToken,
      managerSessionId: _ignoredManagerSessionId,
      ...requestLocalContext
    } = context;
    const sanitizedEnv =
      context.env === undefined
        ? undefined
        : stripAmbientManagerExecutionContext(context.env);
    const data = await executeGraphqlDocument(
      parsedBody.query,
      {
        ...requestLocalContext,
        ...(sanitizedEnv === undefined ? {} : { env: sanitizedEnv }),
        ...(authToken === undefined ? {} : { authToken }),
        ...(managerSessionId === undefined ? {} : { managerSessionId }),
      },
      {
        variables: parsedBody.variables,
        ...(parsedBody.operationName === undefined
          ? {}
          : { operationName: parsedBody.operationName }),
        ...(Object.keys(deps).length === 0 ? {} : { deps }),
      },
    );
    return jsonResponse({ data } satisfies GraphqlExecutionResult);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return graphqlErrorResponse(message);
  }
}
