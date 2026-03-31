import { randomUUID } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";

import { context, trace } from "@opentelemetry/api";
import type {
  Instrumentation,
  InstrumentationConfig
} from "@opentelemetry/instrumentation";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { OpenBoxApiErrorPolicy, OpenBoxClient } from "../client/index.js";
import {
  getPendingApproval,
  isActivityApproved
} from "../governance/approval-registry.js";
import { getOpenBoxExecutionContext } from "../governance/context.js";
import { OpenBoxSpanProcessor } from "../span/index.js";
import {
  ApprovalPendingError,
  GovernanceHaltError,
  Verdict,
  WorkflowEventType
} from "../types/index.js";

const DB_INSTRUMENTATION_NAMES = new Map<string, string[]>([
  ["pg", ["@opentelemetry/instrumentation-pg"]],
  ["postgres", ["@opentelemetry/instrumentation-pg"]],
  ["mysql", ["@opentelemetry/instrumentation-mysql"]],
  ["mysql2", ["@opentelemetry/instrumentation-mysql2"]],
  ["mongodb", ["@opentelemetry/instrumentation-mongodb"]],
  ["mongoose", ["@opentelemetry/instrumentation-mongoose"]],
  ["redis", ["@opentelemetry/instrumentation-redis"]],
  ["ioredis", ["@opentelemetry/instrumentation-ioredis"]],
  ["knex", ["@opentelemetry/instrumentation-knex"]],
  ["oracledb", ["@opentelemetry/instrumentation-oracledb"]],
  ["cassandra", ["@opentelemetry/instrumentation-cassandra-driver"]],
  ["tedious", ["@opentelemetry/instrumentation-tedious"]]
]);

const HTTP_INSTRUMENTATION_DEFINITIONS = [
  {
    exportName: "HttpInstrumentation",
    moduleName: "@opentelemetry/instrumentation-http"
  },
  {
    exportName: "UndiciInstrumentation",
    moduleName: "@opentelemetry/instrumentation-undici"
  }
] as const;

const DB_INSTRUMENTATION_DEFINITIONS = new Map<
  string,
  {
    exportName: string;
    moduleName: string;
  }
>([
  [
    "@opentelemetry/instrumentation-pg",
    {
      exportName: "PgInstrumentation",
      moduleName: "@opentelemetry/instrumentation-pg"
    }
  ],
  [
    "@opentelemetry/instrumentation-mysql",
    {
      exportName: "MySQLInstrumentation",
      moduleName: "@opentelemetry/instrumentation-mysql"
    }
  ],
  [
    "@opentelemetry/instrumentation-mysql2",
    {
      exportName: "MySQL2Instrumentation",
      moduleName: "@opentelemetry/instrumentation-mysql2"
    }
  ],
  [
    "@opentelemetry/instrumentation-mongodb",
    {
      exportName: "MongoDBInstrumentation",
      moduleName: "@opentelemetry/instrumentation-mongodb"
    }
  ],
  [
    "@opentelemetry/instrumentation-mongoose",
    {
      exportName: "MongooseInstrumentation",
      moduleName: "@opentelemetry/instrumentation-mongoose"
    }
  ],
  [
    "@opentelemetry/instrumentation-redis",
    {
      exportName: "RedisInstrumentation",
      moduleName: "@opentelemetry/instrumentation-redis"
    }
  ],
  [
    "@opentelemetry/instrumentation-ioredis",
    {
      exportName: "IORedisInstrumentation",
      moduleName: "@opentelemetry/instrumentation-ioredis"
    }
  ],
  [
    "@opentelemetry/instrumentation-knex",
    {
      exportName: "KnexInstrumentation",
      moduleName: "@opentelemetry/instrumentation-knex"
    }
  ],
  [
    "@opentelemetry/instrumentation-oracledb",
    {
      exportName: "OracleInstrumentation",
      moduleName: "@opentelemetry/instrumentation-oracledb"
    }
  ],
  [
    "@opentelemetry/instrumentation-cassandra-driver",
    {
      exportName: "CassandraDriverInstrumentation",
      moduleName: "@opentelemetry/instrumentation-cassandra-driver"
    }
  ],
  [
    "@opentelemetry/instrumentation-tedious",
    {
      exportName: "TediousInstrumentation",
      moduleName: "@opentelemetry/instrumentation-tedious"
    }
  ]
]);

const DEFAULT_FILE_SKIP_PATTERNS = [
  "/dev/",
  "/proc/",
  "/sys/",
  "\\\\?\\pipe\\",
  "__pycache__",
  ".pyc",
  ".pyo",
  ".so",
  ".dylib"
];

const TEXT_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded"
];

export interface OpenBoxTelemetryOptions {
  captureHttpBodies?: boolean | undefined;
  dbLibraries?: ReadonlySet<string> | undefined;
  fileSkipPatterns?: string[] | undefined;
  governanceClient?: OpenBoxClient | undefined;
  ignoredUrls?: string[] | undefined;
  instrumentDatabases?: boolean | undefined;
  instrumentFileIo?: boolean | undefined;
  onHookApiError?: OpenBoxApiErrorPolicy | undefined;
  spanProcessor: OpenBoxSpanProcessor;
}

export interface OpenBoxTelemetryController {
  instrumentations: Instrumentation<InstrumentationConfig>[];
  shutdown: () => Promise<void>;
  tracerProvider: NodeTracerProvider;
}

export interface OpenBoxTracedOptions {
  captureArgs?: boolean | undefined;
  captureResult?: boolean | undefined;
  module?: string | undefined;
  name?: string | undefined;
  tracerName?: string | undefined;
}

interface HookGovernanceRuntime {
  client: OpenBoxClient;
  onApiError: OpenBoxApiErrorPolicy;
  spanProcessor: OpenBoxSpanProcessor;
}

type HookSpan = NonNullable<ReturnType<typeof trace.getActiveSpan>> & {
  attributes?: Record<string, unknown>;
  name?: string;
};

const APPROVAL_ABORT_PREFIX = "__openbox_approval__:";

let activeFetchRestore: (() => void) | undefined;
let activeFileRestore: (() => void) | undefined;
let activeHookGovernanceRuntime: HookGovernanceRuntime | undefined;
let activeUnregister: (() => void) | undefined;

export function setupOpenBoxOpenTelemetry({
  captureHttpBodies = true,
  dbLibraries,
  fileSkipPatterns = DEFAULT_FILE_SKIP_PATTERNS,
  governanceClient,
  ignoredUrls = [],
  instrumentDatabases = true,
  instrumentFileIo = false,
  onHookApiError,
  spanProcessor
}: OpenBoxTelemetryOptions): OpenBoxTelemetryController {
  teardownActiveTelemetry();
  const require = createRequire(import.meta.url);
  const { registerInstrumentations } = require(
    "@opentelemetry/instrumentation"
  ) as {
    registerInstrumentations: (options: {
      instrumentations: Instrumentation<InstrumentationConfig>[];
      tracerProvider: NodeTracerProvider;
    }) => () => void;
  };

  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [spanProcessor]
  });

  tracerProvider.register();
  const hookGovernance = governanceClient
    ? {
        client: governanceClient,
        onApiError:
          onHookApiError ?? governanceClient.onApiError ?? "fail_open",
        spanProcessor
      }
    : undefined;
  activeHookGovernanceRuntime = hookGovernance;

  const instrumentations: Instrumentation<InstrumentationConfig>[] = [
    ...selectHttpInstrumentations(ignoredUrls, captureHttpBodies),
    ...selectDatabaseInstrumentations(
      instrumentDatabases,
      dbLibraries,
      hookGovernance
    ),
    ...selectFileInstrumentation(instrumentFileIo, fileSkipPatterns)
  ];

  activeUnregister = registerInstrumentations({
    instrumentations,
    tracerProvider
  });

  if (captureHttpBodies) {
    activeFetchRestore = patchFetch(
      spanProcessor,
      ignoredUrls,
      hookGovernance
    );
  }

  if (instrumentFileIo) {
    activeFileRestore = patchFileIo(fileSkipPatterns, hookGovernance);
  }

  return {
    instrumentations,
    async shutdown() {
      teardownActiveTelemetry();
      await tracerProvider.shutdown();
      disableGlobalTraceApi();
    },
    tracerProvider
  };
}

export function traced<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: OpenBoxTracedOptions = {}
): (...args: TArgs) => Promise<TResult> {
  return async function openBoxTraced(this: unknown, ...args: TArgs): Promise<TResult> {
    const hookGovernance = activeHookGovernanceRuntime;

    if (!hookGovernance) {
      return fn.apply(this, args);
    }

    const functionName = options.name ?? fn.name ?? "anonymous";
    const moduleName = options.module ?? "unknown";
    const tracer = trace.getTracer(options.tracerName ?? "openbox.tracing");

    return tracer.startActiveSpan(`function.${functionName}`, async span => {
      const spanContext = span.spanContext();
      const startTimeNs = Date.now() * 1_000_000;
      const hookSpanId = normalizeHexId(undefined, 16);
      span.setAttribute("code.function", functionName);
      span.setAttribute("code.namespace", moduleName);
      let fnStarted = false;

      try {
        await evaluateHookGovernance(hookGovernance, {
          activeSpan: span,
          hookTrigger: {
            attribute_key_identifiers: ["code.function", "code.namespace"],
            ...(options.captureArgs
              ? { args: sanitizeForGovernancePayload(args) }
              : {}),
            function: functionName,
            module: moduleName,
            stage: "started",
            type: "function_call"
          },
          span: createHookSpan({
            attributes: {
              "code.function": functionName,
              "code.namespace": moduleName
            },
            endTimeNs: startTimeNs,
            functionArgs: options.captureArgs ? args : undefined,
            functionModule: moduleName,
            functionName,
            hookType: "function_call",
            kind: "INTERNAL",
            name: `function.${functionName}`,
            parentSpanId: spanContext.spanId,
            semanticType: "function_call",
            spanId: hookSpanId,
            stage: "started",
            startTimeNs,
            traceId: spanContext.traceId
          }),
          stage: "started",
          traceId: spanContext.traceId
        });

        fnStarted = true;
        const result = await fn.apply(this, args);
        const endTimeNs = Date.now() * 1_000_000;

        await evaluateHookGovernance(hookGovernance, {
          activeSpan: span,
          hookTrigger: {
            attribute_key_identifiers: ["code.function", "code.namespace"],
            function: functionName,
            module: moduleName,
            ...(options.captureResult
              ? { result: sanitizeForGovernancePayload(result) }
              : {}),
            stage: "completed",
            type: "function_call"
          },
          span: createHookSpan({
            attributes: {
              "code.function": functionName,
              "code.namespace": moduleName
            },
            endTimeNs,
            functionModule: moduleName,
            functionName,
            functionResult: options.captureResult ? result : undefined,
            hookType: "function_call",
            kind: "INTERNAL",
            name: `function.${functionName}`,
            parentSpanId: spanContext.spanId,
            semanticType: "function_call",
            spanId: hookSpanId,
            stage: "completed",
            startTimeNs,
            traceId: spanContext.traceId
          }),
          stage: "completed",
          traceId: spanContext.traceId
        });

        return result;
      } catch (error) {
        if (fnStarted) {
          const endTimeNs = Date.now() * 1_000_000;

          await evaluateHookGovernance(hookGovernance, {
            activeSpan: span,
            hookTrigger: {
              attribute_key_identifiers: ["code.function", "code.namespace"],
              error:
                error instanceof Error ? error.message : String(error),
              function: functionName,
              module: moduleName,
              stage: "completed",
              type: "function_call"
            },
            span: createHookSpan({
              attributes: {
                "code.function": functionName,
                "code.namespace": moduleName
              },
              endTimeNs,
              error:
                error instanceof Error ? error.message : String(error),
              functionModule: moduleName,
              functionName,
              hookType: "function_call",
              kind: "INTERNAL",
              name: `function.${functionName}`,
              parentSpanId: spanContext.spanId,
              semanticType: "function_call",
              spanId: hookSpanId,
              stage: "completed",
              startTimeNs,
              traceId: spanContext.traceId
            }),
            stage: "completed",
            traceId: spanContext.traceId
          });
        }

        throw error;
      } finally {
        span.end();
      }
    });
  };
}

function selectHttpInstrumentations(
  ignoredUrls: string[],
  captureHttpBodies: boolean
): Instrumentation<InstrumentationConfig>[] {
  if (!captureHttpBodies) {
    return [];
  }

  return HTTP_INSTRUMENTATION_DEFINITIONS.map(definition => {
    if (
      definition.moduleName === "@opentelemetry/instrumentation-http"
    ) {
      return loadInstrumentation(definition, {
        disableIncomingRequestInstrumentation: true,
        headersToSpanAttributes: {},
        ignoreOutgoingRequestHook: (request: {
          host?: string;
          hostname?: string;
          href?: string;
          path?: string;
          port?: string;
          protocol?: string;
        }) => {
          const url = buildRequestUrl(request);

          return shouldIgnoreUrl(url, ignoredUrls);
        }
      });
    }

    return loadInstrumentation(definition);
  });
}

function selectDatabaseInstrumentations(
  instrumentDatabases: boolean,
  dbLibraries?: ReadonlySet<string>,
  hookGovernance?: HookGovernanceRuntime
): Instrumentation<InstrumentationConfig>[] {
  if (!instrumentDatabases) {
    return [];
  }

  const enabledNames =
    dbLibraries && dbLibraries.size > 0
      ? new Set(
          [...dbLibraries].flatMap(name =>
            DB_INSTRUMENTATION_NAMES.get(name.toLowerCase()) ?? []
          )
        )
      : undefined;

  const definitions = enabledNames
    ? [...enabledNames]
        .map(name => DB_INSTRUMENTATION_DEFINITIONS.get(name))
        .filter(
          (
            definition
          ): definition is NonNullable<typeof definition> => definition !== undefined
        )
    : [...DB_INSTRUMENTATION_DEFINITIONS.values()];

  return definitions.map(definition =>
    loadInstrumentation(
      definition,
      createDatabaseInstrumentationConfig(
        definition.moduleName,
        hookGovernance
      )
    )
  );
}

function selectFileInstrumentation(
  instrumentFileIo: boolean,
  fileSkipPatterns: string[]
): Instrumentation<InstrumentationConfig>[] {
  if (!instrumentFileIo) {
    return [];
  }

  const require = createRequire(import.meta.url);
  const { FsInstrumentation } = require(
    "@opentelemetry/instrumentation-fs"
  ) as {
    FsInstrumentation: new (
      config?: unknown
    ) => Instrumentation<InstrumentationConfig>;
  };
  const instrumentation = new FsInstrumentation({
    createHook(
      _functionName: string,
      info: { args: ArrayLike<unknown> }
    ) {
      const filePath = getFilePathFromArgs(info.args);

      if (!filePath) {
        return true;
      }

      if (fileSkipPatterns.some(pattern => filePath.includes(pattern))) {
        return false;
      }

      return !filePath.startsWith("/dev/");
    },
    requireParentSpan: true
  });

  return [instrumentation];
}

function createDatabaseInstrumentationConfig(
  moduleName: string,
  hookGovernance?: HookGovernanceRuntime
): unknown {
  if (!hookGovernance) {
    return undefined;
  }

  const queryStartTimes = new Map<
    string,
    { hookSpanId: string; startTimeNs: number }
  >();
  const emitStarted = (
    span: HookSpan,
    details: {
      dbName?: string | undefined;
      dbOperation?: string | undefined;
      dbStatement?: string | undefined;
      dbSystem?: string | undefined;
      serverAddress?: string | undefined;
      serverPort?: number | undefined;
    }
  ) => {
    const spanId = span.spanContext().spanId;
    const startTimeNs = Date.now() * 1_000_000;
    const hookSpanId = normalizeHexId(undefined, 16);

    queryStartTimes.set(spanId, {
      hookSpanId,
      startTimeNs
    });
    void emitDatabaseHookGovernance({
      details,
      hookSpanId,
      hookGovernance,
      span,
      stage: "started",
      startTimeNs
    }).catch(() => undefined);
  };
  const emitCompleted = (
    span: HookSpan,
    details: {
      dbName?: string | undefined;
      dbOperation?: string | undefined;
      dbStatement?: string | undefined;
      dbSystem?: string | undefined;
      error?: string | undefined;
      serverAddress?: string | undefined;
      serverPort?: number | undefined;
    }
  ) => {
    const spanId = span.spanContext().spanId;
    const trackedSpan = queryStartTimes.get(spanId);
    const startTimeNs = trackedSpan?.startTimeNs ?? Date.now() * 1_000_000;
    const hookSpanId = trackedSpan?.hookSpanId ?? normalizeHexId(undefined, 16);

    queryStartTimes.delete(spanId);

    void emitDatabaseHookGovernance({
      details,
      hookSpanId,
      hookGovernance,
      span,
      stage: "completed",
      startTimeNs
    }).catch(() => undefined);
  };

  if (moduleName === "@opentelemetry/instrumentation-pg") {
    return {
      enhancedDatabaseReporting: true,
      requestHook(
        span: HookSpan,
        info: {
          connection?: {
            database?: string;
            host?: string;
            port?: number;
          };
          query?: {
            text?: string;
          };
        }
      ) {
        const dbStatement =
          info.query?.text ?? toStringValue(getSpanAttribute(span, "db.statement"));

        emitStarted(span, {
          dbName:
            info.connection?.database ??
            toStringValue(getSpanAttribute(span, "db.name")),
          dbOperation:
            parseDbOperation(dbStatement) ??
            toStringValue(getSpanAttribute(span, "db.operation")),
          dbStatement,
          dbSystem: toStringValue(getSpanAttribute(span, "db.system")) ?? "postgresql",
          serverAddress:
            info.connection?.host ??
            toStringValue(getSpanAttribute(span, "server.address")) ??
            toStringValue(getSpanAttribute(span, "net.peer.name")),
          serverPort:
            toNumberValue(getSpanAttribute(span, "server.port")) ??
            toNumberValue(getSpanAttribute(span, "net.peer.port")) ??
            info.connection?.port
        });
      },
      responseHook(
        span: HookSpan
      ) {
        const dbStatement = toStringValue(getSpanAttribute(span, "db.statement"));

        emitCompleted(span, {
          dbName: toStringValue(getSpanAttribute(span, "db.name")),
          dbOperation:
            parseDbOperation(dbStatement) ??
            toStringValue(getSpanAttribute(span, "db.operation")),
          dbStatement,
          dbSystem: toStringValue(getSpanAttribute(span, "db.system")) ?? "postgresql",
          error:
            toStringValue(getSpanAttribute(span, "error.type")) ??
            toStringValue(getSpanAttribute(span, "exception.message")),
          serverAddress:
            toStringValue(getSpanAttribute(span, "server.address")) ??
            toStringValue(getSpanAttribute(span, "net.peer.name")),
          serverPort:
            toNumberValue(getSpanAttribute(span, "server.port")) ??
            toNumberValue(getSpanAttribute(span, "net.peer.port"))
        });
      }
    };
  }

  if (moduleName === "@opentelemetry/instrumentation-oracledb") {
    return {
      enhancedDatabaseReporting: true,
      requestHook(
        span: HookSpan,
        info: {
          connection?: {
            hostName?: string;
            port?: number;
            serviceName?: string;
          };
          inputArgs?: unknown[];
        }
      ) {
        const dbStatement = Array.isArray(info.inputArgs)
          ? toStringValue(info.inputArgs[0])
          : undefined;

        emitStarted(span, {
          dbName:
            info.connection?.serviceName ??
            toStringValue(getSpanAttribute(span, "db.name")),
          dbOperation:
            parseDbOperation(dbStatement) ??
            toStringValue(getSpanAttribute(span, "db.operation")),
          dbStatement:
            dbStatement ?? toStringValue(getSpanAttribute(span, "db.statement")),
          dbSystem: toStringValue(getSpanAttribute(span, "db.system")) ?? "oracle",
          serverAddress:
            info.connection?.hostName ??
            toStringValue(getSpanAttribute(span, "server.address")) ??
            toStringValue(getSpanAttribute(span, "net.peer.name")),
          serverPort:
            toNumberValue(getSpanAttribute(span, "server.port")) ??
            toNumberValue(getSpanAttribute(span, "net.peer.port")) ??
            info.connection?.port
        });
      },
      responseHook(
        span: HookSpan
      ) {
        const dbStatement = toStringValue(getSpanAttribute(span, "db.statement"));

        emitCompleted(span, {
          dbName: toStringValue(getSpanAttribute(span, "db.name")),
          dbOperation:
            parseDbOperation(dbStatement) ??
            toStringValue(getSpanAttribute(span, "db.operation")),
          dbStatement,
          dbSystem: toStringValue(getSpanAttribute(span, "db.system")) ?? "oracle",
          error:
            toStringValue(getSpanAttribute(span, "error.type")) ??
            toStringValue(getSpanAttribute(span, "exception.message")),
          serverAddress:
            toStringValue(getSpanAttribute(span, "server.address")) ??
            toStringValue(getSpanAttribute(span, "net.peer.name")),
          serverPort:
            toNumberValue(getSpanAttribute(span, "server.port")) ??
            toNumberValue(getSpanAttribute(span, "net.peer.port"))
        });
      }
    };
  }

  return undefined;
}

async function emitDatabaseHookGovernance(input: {
  details: {
    dbName?: string | undefined;
    dbOperation?: string | undefined;
    dbStatement?: string | undefined;
    dbSystem?: string | undefined;
    error?: string | undefined;
    serverAddress?: string | undefined;
    serverPort?: number | undefined;
  };
  hookSpanId: string;
  hookGovernance: HookGovernanceRuntime;
  span: HookSpan;
  stage: "completed" | "started";
  startTimeNs: number;
}): Promise<void> {
  const spanContext = input.span.spanContext();
  const nowNs = Date.now() * 1_000_000;
  const dbOperation = input.details.dbOperation ?? "query";

  const hookTrigger: Record<string, unknown> = {
    attribute_key_identifiers: ["db.system", "db.operation", "db.statement"],
    db_name: input.details.dbName,
    db_operation: dbOperation,
    db_statement: input.details.dbStatement,
    db_system: input.details.dbSystem ?? "unknown",
    server_address: input.details.serverAddress,
    server_port: input.details.serverPort,
    stage: input.stage,
    type: "db_query"
  };

  if (input.stage === "completed") {
    hookTrigger.duration_ms = Math.max(
      0,
      Math.round((nowNs - input.startTimeNs) / 1_000_000)
    );
    hookTrigger.error = input.details.error;
  }

  await evaluateHookGovernance(input.hookGovernance, {
    activeSpan: input.span,
    hookTrigger,
    span: createHookSpan({
      attributes: {
        "db.name": input.details.dbName ?? "unknown",
        "db.operation": dbOperation,
        "db.statement": input.details.dbStatement ?? "",
        "db.system": input.details.dbSystem ?? "unknown",
        ...(input.details.serverAddress
          ? { "server.address": input.details.serverAddress }
          : {}),
        ...(typeof input.details.serverPort === "number"
          ? { "server.port": input.details.serverPort }
          : {})
      },
      dbName: input.details.dbName,
      dbOperation,
      dbStatement: input.details.dbStatement,
      dbSystem: input.details.dbSystem ?? "unknown",
      endTimeNs: nowNs,
      error: input.details.error,
      hookType: "db_query",
      kind: "CLIENT",
      name: input.span.name ?? `DB ${dbOperation}`,
      parentSpanId: spanContext.spanId,
      semanticType: resolveDatabaseSemanticType(dbOperation),
      serverAddress: input.details.serverAddress,
      serverPort: input.details.serverPort,
      spanId: input.hookSpanId,
      stage: input.stage,
      startTimeNs: input.startTimeNs,
      traceId: spanContext.traceId
    }),
    stage: input.stage,
    traceId: spanContext.traceId
  });
}

function patchFetch(
  spanProcessor: OpenBoxSpanProcessor,
  ignoredUrls: string[],
  hookGovernance?: HookGovernanceRuntime
): () => void {
  const originalFetch = globalThis.fetch;

  if (!originalFetch || !globalThis.Request || !globalThis.Response || !globalThis.Headers) {
    throw new Error("Global fetch APIs are required for OpenBox HTTP body capture");
  }

  globalThis.fetch = async function patchedFetch(
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> {
    const request = new globalThis.Request(input, init);
    const url = request.url;

    if (shouldIgnoreUrl(url, ignoredUrls)) {
      return originalFetch(request);
    }

    const activeSpan = trace.getActiveSpan();

    if (!activeSpan) {
      return originalFetch(request);
    }

    const requestBody = normalizeHookBodyForTelemetry(
      await captureRequestBody(request)
    );
    const requestHeaders = headersToRecord(request.headers);
    const spanContext = activeSpan.spanContext();
    const startTimeNs = Date.now() * 1_000_000;
    const hookSpanId = normalizeHexId(undefined, 16);
    const startedSemanticType = resolveHttpSemanticType({
      method: request.method,
      requestBody,
      url
    });

    await evaluateHookGovernance(hookGovernance, {
      activeSpan,
      hookTrigger: {
        method: request.method,
        request_body: requestBody,
        request_headers: requestHeaders,
        stage: "started",
        type: "http_request",
        url
      },
      span: createHookSpan({
        attributes: {
          "http.method": request.method,
          "http.url": url
        },
        endTimeNs: startTimeNs,
        hookType: "http_request",
        httpMethod: request.method,
        httpUrl: url,
        kind: "CLIENT",
        name: `HTTP ${request.method}`,
        parentSpanId: spanContext.spanId,
        requestBody,
        requestHeaders,
        semanticType: startedSemanticType,
        spanId: hookSpanId,
        stage: "started",
        startTimeNs: startTimeNs,
        traceId: spanContext.traceId
      }),
      stage: "started",
      traceId: spanContext.traceId
    });

    const response = await originalFetch(request);
    const responseHeaders = headersToRecord(response.headers);
    const responseBody = normalizeHookBodyForTelemetry(
      await captureResponseBody(response)
    );

    spanProcessor.storeTraceBody(spanContext.traceId, {
      method: request.method,
      requestBody,
      requestHeaders,
      responseBody,
      responseHeaders,
      url
    });
    const endTimeNs = Date.now() * 1_000_000;
    const completedHookTrigger = {
      method: request.method,
      request_body: requestBody,
      request_headers: requestHeaders,
      response_body: responseBody,
      response_headers: responseHeaders,
      status_code: response.status,
      type: "http_request",
      url
    } as const;
    const completedSemanticType = resolveHttpSemanticType({
      method: request.method,
      requestBody,
      responseBody,
      url
    });
    const completedHookSpanBase = {
      attributes: {
        "http.method": request.method,
        "http.status_code": response.status,
        "http.url": url
      },
      endTimeNs,
      hookType: "http_request" as const,
      httpMethod: request.method,
      httpStatusCode: response.status,
      httpUrl: url,
      kind: "CLIENT" as const,
      name: `HTTP ${request.method}`,
      parentSpanId: spanContext.spanId,
      requestBody,
      requestHeaders,
      responseBody,
      responseHeaders,
      semanticType: completedSemanticType,
      spanId: hookSpanId,
      startTimeNs,
      traceId: spanContext.traceId
    };

    await evaluateHookGovernance(hookGovernance, {
      activeSpan,
      hookTrigger: {
        ...completedHookTrigger,
        stage: "completed",
      },
      span: createHookSpan({
        ...completedHookSpanBase,
        stage: "completed",
      }),
      stage: "completed",
      traceId: spanContext.traceId
    });

    return response;
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function captureRequestBody(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get("content-type");

  if (!isTextContentType(contentType)) {
    return undefined;
  }

  const clone = request.clone();
  const text = await clone.text();

  return text || undefined;
}

async function captureResponseBody(
  response: Response
): Promise<string | undefined> {
  const contentType = response.headers.get("content-type");

  if (!isTextContentType(contentType)) {
    return undefined;
  }

  const clone = response.clone();
  const text = await clone.text();

  return text || undefined;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};

  headers.forEach((value, key) => {
    result[key] = value;
  });

  return result;
}

function shouldIgnoreUrl(url: string | undefined, ignoredUrls: string[]): boolean {
  if (!url) {
    return false;
  }

  return ignoredUrls.some(prefix => url.startsWith(prefix));
}

function resolveHttpSemanticType(input: {
  method: string;
  requestBody?: string | undefined;
  responseBody?: string | undefined;
  url: string;
}): string {
  const normalizedMethod = input.method.trim().toUpperCase();
  const requestRecords = parseHookBodyRecords(input.requestBody);
  const responseRecords = parseHookBodyRecords(input.responseBody);
  const modelId =
    extractModelFromRecords(responseRecords) ??
    extractModelFromRecords(requestRecords);
  const provider =
    inferProviderFromUrl(input.url) ?? inferProviderFromModelId(modelId);

  if (normalizedMethod === "POST" && provider) {
    return isLikelyLlmEmbedding(input.url, requestRecords, responseRecords)
      ? "llm_embedding"
      : "llm_completion";
  }

  switch (normalizedMethod) {
    case "GET":
      return "http_get";
    case "POST":
      return "http_post";
    case "PUT":
      return "http_put";
    case "PATCH":
      return "http_patch";
    case "DELETE":
      return "http_delete";
    default:
      return "http";
  }
}

function resolveDatabaseSemanticType(operation: string): string {
  const normalized = operation.trim().toUpperCase();

  switch (normalized) {
    case "SELECT":
      return "database_select";
    case "INSERT":
      return "database_insert";
    case "UPDATE":
      return "database_update";
    case "DELETE":
      return "database_delete";
    default:
      return "database_query";
  }
}

function isLikelyLlmEmbedding(
  url: string,
  requestRecords: Array<Record<string, unknown>>,
  responseRecords: Array<Record<string, unknown>>
): boolean {
  const normalizedUrl = url.toLowerCase();

  if (normalizedUrl.includes("embedding")) {
    return true;
  }

  const combined = JSON.stringify([...requestRecords, ...responseRecords]).toLowerCase();
  return combined.includes("embedding");
}

function isTextContentType(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }

  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";

  return TEXT_CONTENT_TYPES.some(type => normalized.startsWith(type));
}

function buildRequestUrl(request: {
  host?: string;
  hostname?: string;
  href?: string;
  path?: string;
  port?: string;
  protocol?: string;
}): string | undefined {
  if (request.href) {
    return request.href;
  }

  if (!request.protocol || !(request.host || request.hostname)) {
    return undefined;
  }

  const host = request.host ?? request.hostname;

  return `${request.protocol}//${host}${request.path ?? ""}`;
}

function getFilePathFromArgs(args: ArrayLike<unknown>): string | undefined {
  const candidate = args[0];

  return typeof candidate === "string" ? candidate : undefined;
}

function teardownActiveTelemetry(): void {
  activeFetchRestore?.();
  activeFetchRestore = undefined;
  activeFileRestore?.();
  activeFileRestore = undefined;
  activeHookGovernanceRuntime = undefined;
  activeUnregister?.();
  activeUnregister = undefined;
}

function disableGlobalTraceApi(): void {
  const traceApi = trace as unknown as { disable?: () => void };
  traceApi.disable?.();
}

function patchFileIo(
  fileSkipPatterns: string[],
  hookGovernance?: HookGovernanceRuntime
): () => void {
  const require = createRequire(import.meta.url);
  const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  const fsModule = require("node:fs") as typeof import("node:fs");
  const tracer = trace.getTracer("openbox.file-io");
  const originalReadFile = fsPromises.readFile;
  const originalWriteFile = fsPromises.writeFile;
  const originalFsReadFile = fsModule.promises.readFile;
  const originalFsWriteFile = fsModule.promises.writeFile;

  const tracedReadFile = async function openBoxReadFile(
    ...args: Parameters<typeof originalReadFile>
  ): Promise<Awaited<ReturnType<typeof originalReadFile>>> {
    const [path] = args;
    const filePath = String(path);

    if (shouldSkipFilePath(filePath, fileSkipPatterns)) {
      return originalReadFile(...args);
    }

    return context.with(context.active(), async () => {
      return tracer.startActiveSpan("file.read", async span => {
        span.setAttribute("file.path", filePath);
        span.setAttribute("file.operation", "read");
        const spanContext = span.spanContext();
        const startTimeNs = Date.now() * 1_000_000;
        const hookSpanId = normalizeHexId(undefined, 16);

        await evaluateHookGovernance(hookGovernance, {
          activeSpan: span,
          hookTrigger: {
            attribute_key_identifiers: ["file.path", "file.operation"],
            file_operation: "read",
            file_path: filePath,
            stage: "started",
            type: "file_operation"
          },
          span: createHookSpan({
            attributes: {
              "file.operation": "read",
              "file.path": filePath
            },
            endTimeNs: startTimeNs,
            fileMode: "r",
            fileOperation: "read",
            filePath,
            hookType: "file_operation",
            kind: "INTERNAL",
            name: "file.read",
            parentSpanId: spanContext.spanId,
            semanticType: "file_read",
            spanId: hookSpanId,
            stage: "started",
            startTimeNs,
            traceId: spanContext.traceId
          }),
          stage: "started",
          traceId: spanContext.traceId
        });

        try {
          const result = await originalReadFile(...args);
          const bytes = getByteLength(result);
          const endTimeNs = Date.now() * 1_000_000;
          span.setAttribute("file.bytes", bytes);

          await evaluateHookGovernance(hookGovernance, {
            activeSpan: span,
            hookTrigger: {
              attribute_key_identifiers: ["file.path", "file.operation"],
              bytes_read: bytes,
              file_operation: "read",
              file_path: filePath,
              stage: "completed",
              type: "file_operation"
            },
            span: createHookSpan({
              attributes: {
                "file.bytes": bytes,
                "file.operation": "read",
                "file.path": filePath
              },
              bytesRead: bytes,
              endTimeNs,
              fileMode: "r",
              fileOperation: "read",
              filePath,
              hookType: "file_operation",
              kind: "INTERNAL",
              name: "file.read",
              parentSpanId: spanContext.spanId,
              semanticType: "file_read",
              spanId: hookSpanId,
              stage: "completed",
              startTimeNs,
              traceId: spanContext.traceId
            }),
            stage: "completed",
            traceId: spanContext.traceId
          });

          return result;
        } finally {
          span.end();
        }
      });
    });
  };

  const tracedWriteFile = async function openBoxWriteFile(
    ...args: Parameters<typeof originalWriteFile>
  ): Promise<Awaited<ReturnType<typeof originalWriteFile>>> {
    const [file, data] = args;
    const filePath = String(file);

    if (shouldSkipFilePath(filePath, fileSkipPatterns)) {
      return originalWriteFile(...args);
    }

    return context.with(context.active(), async () => {
      return tracer.startActiveSpan("file.write", async span => {
        span.setAttribute("file.path", filePath);
        span.setAttribute("file.operation", "write");
        const bytes = getByteLength(data);
        const spanContext = span.spanContext();
        const startTimeNs = Date.now() * 1_000_000;
        const hookSpanId = normalizeHexId(undefined, 16);
        span.setAttribute("file.bytes", bytes);

        await evaluateHookGovernance(hookGovernance, {
          activeSpan: span,
          hookTrigger: {
            attribute_key_identifiers: ["file.path", "file.operation"],
            bytes_written: bytes,
            file_operation: "write",
            file_path: filePath,
            stage: "started",
            type: "file_operation"
          },
          span: createHookSpan({
            attributes: {
              "file.bytes": bytes,
              "file.operation": "write",
              "file.path": filePath
            },
            bytesWritten: bytes,
            endTimeNs: startTimeNs,
            fileMode: "w",
            fileOperation: "write",
            filePath,
            hookType: "file_operation",
            kind: "INTERNAL",
            name: "file.write",
            parentSpanId: spanContext.spanId,
            semanticType: "file_write",
            spanId: hookSpanId,
            stage: "started",
            startTimeNs,
            traceId: spanContext.traceId
          }),
          stage: "started",
          traceId: spanContext.traceId
        });

        try {
          const result = await originalWriteFile(...args);
          const endTimeNs = Date.now() * 1_000_000;

          await evaluateHookGovernance(hookGovernance, {
            activeSpan: span,
            hookTrigger: {
              attribute_key_identifiers: ["file.path", "file.operation"],
              bytes_written: bytes,
              file_operation: "write",
              file_path: filePath,
              stage: "completed",
              type: "file_operation"
            },
            span: createHookSpan({
              attributes: {
                "file.bytes": bytes,
                "file.operation": "write",
                "file.path": filePath
              },
              bytesWritten: bytes,
              endTimeNs,
              fileMode: "w",
              fileOperation: "write",
              filePath,
              hookType: "file_operation",
              kind: "INTERNAL",
              name: "file.write",
              parentSpanId: spanContext.spanId,
              semanticType: "file_write",
              spanId: hookSpanId,
              stage: "completed",
              startTimeNs,
              traceId: spanContext.traceId
            }),
            stage: "completed",
            traceId: spanContext.traceId
          });

          return result;
        } finally {
          span.end();
        }
      });
    });
  };

  fsPromises.readFile = tracedReadFile as typeof fsPromises.readFile;
  fsPromises.writeFile = tracedWriteFile as typeof fsPromises.writeFile;
  fsModule.promises.readFile = tracedReadFile as typeof fsModule.promises.readFile;
  fsModule.promises.writeFile = tracedWriteFile as typeof fsModule.promises.writeFile;
  syncBuiltinESMExports();

  return () => {
    fsPromises.readFile = originalReadFile;
    fsPromises.writeFile = originalWriteFile;
    fsModule.promises.readFile = originalFsReadFile;
    fsModule.promises.writeFile = originalFsWriteFile;
    syncBuiltinESMExports();
  };
}

function getByteLength(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(value);
  }

  if (value instanceof Uint8Array) {
    return value.byteLength;
  }

  return 0;
}

function shouldSkipFilePath(filePath: string, fileSkipPatterns: string[]): boolean {
  return fileSkipPatterns.some(pattern => filePath.includes(pattern));
}

async function evaluateHookGovernance(
  hookGovernance: HookGovernanceRuntime | undefined,
  input: {
    activeSpan: HookSpan;
    hookTrigger: Record<string, unknown>;
    span: Record<string, unknown>;
    stage: "completed" | "started";
    traceId: string;
  }
): Promise<void> {
  if (!hookGovernance) {
    return;
  }

  const activityContext = resolveActivityContext(
    hookGovernance.spanProcessor,
    input.traceId
  );

  if (!activityContext) {
    return;
  }

  const hookSpan = enrichHookSpanForData(
    cloneHookSpanPayload(input.span)
  );
  const hookSpanForPayload =
    input.stage === "started"
      ? ensureStartedHookSpan(hookSpan)
      : ensureCompletedHookSpan(hookSpan);

  // Agent runs already export LLM spans through wrapAgent signal/workflow
  // telemetry. Emitting hook governance requests here would fabricate a
  // synthetic parent activity (`agentLlmCompletion`) that OpenBox renders as a
  // standalone activity row. Queue the hook span for the agent_output signal
  // instead of evaluating it as a governance activity.
  if (activityContext.syntheticAgentActivity) {
    hookGovernance.spanProcessor.appendAgentSignalHookSpan(
      activityContext.workflowId,
      activityContext.runId,
      hookSpanForPayload
    );
    return;
  }

  const priorAbortReason = hookGovernance.spanProcessor.getActivityAbort(
    activityContext.workflowId,
    activityContext.activityId
  );

  if (priorAbortReason) {
    if (priorAbortReason.startsWith(APPROVAL_ABORT_PREFIX)) {
      throw new ApprovalPendingError(
        priorAbortReason.slice(APPROVAL_ABORT_PREFIX.length)
      );
    }

    throw new GovernanceHaltError(`Governance blocked: ${priorAbortReason}`);
  }

  const parentActivityApproved = isActivityApproved(
    activityContext.runId,
    activityContext.activityId
  );

  const pendingApproval = getPendingApproval(activityContext.runId);

  // While a parent activity approval is pending, suppress nested hook-level
  // governance checks for that same activity to avoid duplicate approval loops.
  if (pendingApproval?.activityId === activityContext.activityId) {
    return;
  }

  hookGovernance.spanProcessor.markGoverned(
    input.activeSpan.spanContext().spanId
  );
  const modelUsage = extractModelUsageFromHookSpan(hookSpan);
  const telemetryModelId = toTelemetryModelId(modelUsage.modelId);
  const hookType =
    toStringValue(hookSpan.hook_type) ??
    toStringValue(input.hookTrigger.type) ??
    "hook";
  const hookActivityType = resolveHookActivityType(
    activityContext.activityType,
    hookType
  );
  // OpenBox core stores hook spans as updates on an existing parent
  // ActivityStarted governance event. Emitting a separate hook activity id or
  // a hook ActivityCompleted event causes OpenBox to create extra activity rows
  // instead of attaching the span to the parent activity.
  const eventType = WorkflowEventType.ACTIVITY_STARTED;

  const payload: Record<string, unknown> = {
    activity_id: activityContext.activityId,
    attempt:
      typeof activityContext.attempt === "number"
        ? activityContext.attempt
        : 1,
    activity_type: hookActivityType,
    event_type: eventType,
    hook_trigger: true,
    ...(activityContext.goal ? { goal: activityContext.goal } : {}),
    run_id: activityContext.runId,
    source: "workflow-telemetry",
    ...(modelUsage.modelId ? { model_id: modelUsage.modelId } : {}),
    ...(telemetryModelId ? { model: telemetryModelId } : {}),
    ...(modelUsage.provider ? { model_provider: modelUsage.provider } : {}),
    ...(modelUsage.provider ? { provider: modelUsage.provider } : {}),
    ...(typeof modelUsage.inputTokens === "number"
      ? { input_tokens: modelUsage.inputTokens }
      : {}),
    ...(typeof modelUsage.outputTokens === "number"
      ? { output_tokens: modelUsage.outputTokens }
      : {}),
    ...(typeof modelUsage.totalTokens === "number"
      ? { total_tokens: modelUsage.totalTokens }
      : {}),
    span_count: 1,
    spans: [hookSpanForPayload],
    task_queue: activityContext.taskQueue,
    timestamp: new Date().toISOString(),
    workflow_id: activityContext.workflowId,
    workflow_type: activityContext.workflowType
  };

  if (activityContext.activityInput !== undefined) {
    payload.activity_input = activityContext.activityInput;
  }

  if (activityContext.activityType === "agentLlmCompletion") {
    const derivedActivityPayload = deriveAgentHookActivityPayload(
      input.hookTrigger,
      input.stage
    );

    if (
      payload.activity_input === undefined &&
      derivedActivityPayload.activityInput !== undefined
    ) {
      payload.activity_input = derivedActivityPayload.activityInput;
    }

    if (derivedActivityPayload.activityOutput !== undefined) {
      payload.activity_output = derivedActivityPayload.activityOutput;
    }
  }

  if (activityContext.goal) {
    payload.activity_input = appendGoalToHookActivityInput(
      payload.activity_input,
      activityContext.goal
    );
  }

  let verdict;

  try {
    verdict = await hookGovernance.client.evaluate(payload);
  } catch (error) {
    if (hookGovernance.onApiError === "fail_open") {
      return;
    }

    throw new GovernanceHaltError(
      `Governance API error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (
    !verdict ||
    (!Verdict.shouldStop(verdict.verdict) &&
      !Verdict.requiresApproval(verdict.verdict))
  ) {
    return;
  }

  // Activity already approved by a human should still emit telemetry,
  // but nested hook verdicts must not trigger another approval/halt path.
  if (parentActivityApproved) {
    return;
  }

  const reason = verdict.reason ?? "Hook blocked by governance";

  const abortReason = Verdict.requiresApproval(verdict.verdict)
    ? `${APPROVAL_ABORT_PREFIX}${reason}`
    : reason;

  hookGovernance.spanProcessor.setActivityAbort(
    activityContext.workflowId,
    activityContext.activityId,
    abortReason
  );

  if (Verdict.requiresApproval(verdict.verdict)) {
    throw new ApprovalPendingError(reason);
  }

  if (verdict.verdict === Verdict.HALT) {
    hookGovernance.spanProcessor.setHaltRequested(
      activityContext.workflowId,
      activityContext.activityId,
      reason
    );
  }

  throw new GovernanceHaltError(`Governance blocked: ${reason}`);
}

function resolveHookActivityType(
  parentActivityType: string | undefined,
  hookType: string
): string {
  if (
    typeof parentActivityType === "string" &&
    parentActivityType.toLowerCase() === "agentllmcompletion"
  ) {
    return parentActivityType;
  }

  return hookType;
}

function cloneHookSpanPayload(
  span: Record<string, unknown>
): Record<string, unknown> {
  try {
    return structuredClone(span);
  } catch {
    return { ...span };
  }
}

function ensureStartedHookSpan(
  span: Record<string, unknown>
): Record<string, unknown> {
  const startedSpan = cloneHookSpanPayload(span);
  startedSpan.stage = "started";
  delete startedSpan.end_time;
  delete startedSpan.duration_ns;
  delete startedSpan.response_body;
  delete startedSpan.response_headers;
  delete startedSpan.http_status_code;
  delete startedSpan.rowcount;
  delete startedSpan.data;
  delete startedSpan.bytes_read;
  delete startedSpan.bytes_written;
  delete startedSpan.lines_count;
  delete startedSpan.result;
  delete startedSpan.error;

  return enrichHookSpanForData(startedSpan);
}

function ensureCompletedHookSpan(
  span: Record<string, unknown>
): Record<string, unknown> {
  const completedSpan = cloneHookSpanPayload(span);
  completedSpan.stage = "completed";

  return enrichHookSpanForData(completedSpan);
}

function enrichHookSpanForData(
  span: Record<string, unknown>
): Record<string, unknown> {
  if (span.data !== undefined) {
    return span;
  }

  const hookType = toStringValue(span.hook_type);

  if (!hookType) {
    return span;
  }

  if (hookType === "http_request") {
    const data: Record<string, unknown> = {};
    const method = toStringValue(span.http_method);
    const url = toStringValue(span.http_url);
    const requestBody = toStringValue(span.request_body);
    const responseBody = toStringValue(span.response_body);
    const statusCode = toNumberValue(span.http_status_code);

    if (method) {
      data.method = method;
    }
    if (url) {
      data.url = url;
    }
    if (requestBody !== undefined) {
      data.request_body = requestBody;
    }
    if (responseBody !== undefined) {
      data.response_body = responseBody;
    }
    if (statusCode !== undefined) {
      data.status_code = statusCode;
    }

    if (Object.keys(data).length > 0) {
      span.data = data;
    }

    return span;
  }

  if (hookType === "db_query") {
    const data: Record<string, unknown> = {};
    const dbSystem = toStringValue(span.db_system);
    const dbName = toStringValue(span.db_name);
    const dbOperation = toStringValue(span.db_operation);
    const dbStatement = toStringValue(span.db_statement);
    const rowcount = toNumberValue(span.rowcount);
    const serverAddress = toStringValue(span.server_address);
    const serverPort = toNumberValue(span.server_port);

    if (dbSystem) {
      data.db_system = dbSystem;
    }
    if (dbName) {
      data.db_name = dbName;
    }
    if (dbOperation) {
      data.db_operation = dbOperation;
    }
    if (dbStatement) {
      data.db_statement = dbStatement;
    }
    if (rowcount !== undefined) {
      data.rowcount = rowcount;
    }
    if (serverAddress) {
      data.server_address = serverAddress;
    }
    if (serverPort !== undefined) {
      data.server_port = serverPort;
    }

    if (Object.keys(data).length > 0) {
      span.data = data;
    }

    return span;
  }

  if (hookType === "function_call") {
    const data: Record<string, unknown> = {};
    const functionName = toStringValue(span.function);
    const module = toStringValue(span.module);

    if (functionName) {
      data.function = functionName;
    }
    if (module) {
      data.module = module;
    }
    if (span.args !== undefined) {
      data.args = span.args;
    }
    if (span.result !== undefined) {
      data.result = span.result;
    }

    if (Object.keys(data).length > 0) {
      span.data = data;
    }

    return span;
  }

  if (hookType === "file_operation") {
    const data: Record<string, unknown> = {};
    const filePath = toStringValue(span.file_path);
    const fileMode = toStringValue(span.file_mode);
    const fileOperation = toStringValue(span.file_operation);
    const bytesRead = toNumberValue(span.bytes_read);
    const bytesWritten = toNumberValue(span.bytes_written);
    const linesCount = toNumberValue(span.lines_count);

    if (filePath) {
      data.file_path = filePath;
    }
    if (fileMode) {
      data.file_mode = fileMode;
    }
    if (fileOperation) {
      data.file_operation = fileOperation;
    }
    if (bytesRead !== undefined) {
      data.bytes_read = bytesRead;
    }
    if (bytesWritten !== undefined) {
      data.bytes_written = bytesWritten;
    }
    if (linesCount !== undefined) {
      data.lines_count = linesCount;
    }

    if (Object.keys(data).length > 0) {
      span.data = data;
    }
  }

  return span;
}

function extractModelUsageFromHookSpan(span: Record<string, unknown>): {
  inputTokens?: number;
  modelId?: string;
  outputTokens?: number;
  provider?: string;
  totalTokens?: number;
} {
  const requestBody = toStringValue(span.request_body ?? span.requestBody);
  const responseBody = toStringValue(span.response_body ?? span.responseBody);
  const requestRecords = parseHookBodyRecords(requestBody);
  const responseRecords = parseHookBodyRecords(responseBody);
  const modelFromResponse = extractModelFromRecords(responseRecords);
  const modelFromRequest = extractModelFromRecords(requestRecords);
  const modelId = modelFromResponse ?? modelFromRequest;
  const usageFromResponse = extractUsageFromRecords(responseRecords);
  const attributes =
    span.attributes && typeof span.attributes === "object"
      ? (span.attributes as Record<string, unknown>)
      : undefined;
  const providerFromRecords =
    extractProviderFromRecords(responseRecords) ??
    extractProviderFromRecords(requestRecords);
  const providerFromUrl = inferProviderFromUrl(
    toStringValue(attributes?.["http.url"] ?? attributes?.["url.full"])
  );
  const providerFromModel = inferProviderFromModelId(modelId);
  const provider =
    providerFromRecords ?? providerFromUrl ?? providerFromModel;

  return {
    ...(modelId ? { modelId } : {}),
    ...(provider ? { provider } : {}),
    ...(usageFromResponse?.inputTokens !== undefined
      ? { inputTokens: usageFromResponse.inputTokens }
      : {}),
    ...(usageFromResponse?.outputTokens !== undefined
      ? { outputTokens: usageFromResponse.outputTokens }
      : {}),
    ...(usageFromResponse?.totalTokens !== undefined
      ? { totalTokens: usageFromResponse.totalTokens }
      : {})
  };
}

function parseHookBodyRecords(body: string | undefined): Array<Record<string, unknown>> {
  if (!body) {
    return [];
  }

  const serializedRecords = new Set<string>();
  const records: Array<Record<string, unknown>> = [];
  const pushRecord = (record: Record<string, unknown> | undefined) => {
    if (!record) {
      return;
    }

    const serialized = JSON.stringify(record);

    if (serializedRecords.has(serialized)) {
      return;
    }

    serializedRecords.add(serialized);
    records.push(record);
  };
  const direct = parseJsonRecord(body);

  pushRecord(direct);

  for (const eventBody of parseSseDataBodies(body)) {
    pushRecord(parseJsonRecord(eventBody));
  }

  for (const eventBody of parseInlineSseDataBodies(body)) {
    pushRecord(parseJsonRecord(eventBody));
  }

  return records;
}

function deriveAgentHookActivityPayload(
  hookTrigger: Record<string, unknown>,
  stage: "completed" | "started"
): {
  activityInput?: unknown;
  activityOutput?: unknown;
} {
  const hookType = toStringValue(hookTrigger.type);

  if (hookType === "http_request") {
    const requestRecords = parseHookBodyRecords(
      toStringValue(hookTrigger.request_body)
    );
    const responseRecords = parseHookBodyRecords(
      toStringValue(hookTrigger.response_body)
    );
    const activityInput = normalizeActivityInputList(
      compactHookPayloadValue(
        deriveAgentRequestSummaryFromRecords(requestRecords) ??
          parseHookPayloadBodyValue(hookTrigger.request_body)
      )
    );
    const activityOutput =
      stage === "completed"
        ? compactHookPayloadValue(
            deriveAgentResponseSummaryFromRecords(responseRecords) ??
              parseHookPayloadBodyValue(hookTrigger.response_body)
          )
        : undefined;

    return {
      ...(activityInput !== undefined ? { activityInput } : {}),
      ...(activityOutput !== undefined ? { activityOutput } : {})
    };
  }

  if (hookType === "function_call") {
    const activityInput = normalizeActivityInputList(
      compactHookPayloadValue(sanitizeForGovernancePayload(hookTrigger.args))
    );
    const activityOutput =
      stage === "completed"
        ? compactHookPayloadValue(
            sanitizeForGovernancePayload(hookTrigger.result)
          )
        : undefined;

    return {
      ...(activityInput !== undefined ? { activityInput } : {}),
      ...(activityOutput !== undefined ? { activityOutput } : {})
    };
  }

  return {};
}

function parseHookPayloadBodyValue(body: unknown): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body !== "string") {
    return sanitizeForGovernancePayload(body);
  }

  const trimmed = body.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    return sanitizeForGovernancePayload(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

function compactHookPayloadValue(
  value: unknown,
  maxBytes = 16_384
): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 8_000
      ? `${trimmed.slice(0, 7_984)}...[truncated]`
      : trimmed;
  }

  const serialized = JSON.stringify(value);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");

  if (sizeBytes <= maxBytes) {
    return value;
  }

  return {
    preview: `${serialized.slice(0, 3_984)}...[truncated]`,
    truncated: true
  };
}

function normalizeActivityInputList(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value as unknown[];
  }

  return [value];
}

function appendGoalToHookActivityInput(
  activityInput: unknown,
  goal: string
): unknown[] {
  const trimmedGoal = goal.trim();

  if (trimmedGoal.length === 0) {
    if (Array.isArray(activityInput)) {
      return activityInput;
    }

    if (activityInput === undefined || activityInput === null) {
      return [];
    }

    return [activityInput];
  }

  if (Array.isArray(activityInput)) {
    const inputItems = activityInput as unknown[];

    if (inputItems.length === 0) {
      return [{ goal: trimmedGoal }];
    }

    const [first, ...rest] = inputItems;

    if (first && typeof first === "object" && !Array.isArray(first)) {
      const firstRecord = first as Record<string, unknown>;
      const existingGoal = firstRecord.goal;

      if (typeof existingGoal === "string" && existingGoal.trim().length > 0) {
        return inputItems;
      }

      return [{ ...firstRecord, goal: trimmedGoal }, ...rest];
    }

    return [...inputItems, { goal: trimmedGoal }];
  }

  if (activityInput === undefined || activityInput === null) {
    return [{ goal: trimmedGoal }];
  }

  if (activityInput && typeof activityInput === "object" && !Array.isArray(activityInput)) {
    const activityRecord = activityInput as Record<string, unknown>;
    const existingGoal = activityRecord.goal;

    if (typeof existingGoal === "string" && existingGoal.trim().length > 0) {
      return [activityRecord];
    }

    return [{ ...activityRecord, goal: trimmedGoal }];
  }

  return [activityInput, { goal: trimmedGoal }];
}

function parseInlineSseDataBodies(body: string): string[] {
  const payloads: string[] = [];
  let searchIndex = 0;

  while (searchIndex < body.length) {
    const dataIndex = body.indexOf("data:", searchIndex);

    if (dataIndex < 0) {
      break;
    }

    const jsonStart = body.indexOf("{", dataIndex + 5);

    if (jsonStart < 0) {
      searchIndex = dataIndex + 5;
      continue;
    }

    const jsonEnd = findJsonObjectEnd(body, jsonStart);

    if (jsonEnd < 0) {
      searchIndex = dataIndex + 5;
      continue;
    }

    payloads.push(body.slice(jsonStart, jsonEnd + 1));
    searchIndex = jsonEnd + 1;
  }

  return payloads;
}

function findJsonObjectEnd(source: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (!char) {
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function deriveAgentRequestSummaryFromRecords(
  records: Array<Record<string, unknown>>
): Record<string, unknown> | undefined {
  const modelId = extractModelFromRecords(records);
  const telemetryModelId = modelId ? toTelemetryModelId(modelId) : undefined;
  const prompt = extractLatestUserPromptFromRecords(records);
  const toolCount = extractToolCountFromRecords(records);
  const summary: Record<string, unknown> = {
    ...(telemetryModelId ? { model: telemetryModelId } : {}),
    ...(modelId && modelId !== telemetryModelId ? { model_id: modelId } : {}),
    ...(prompt ? { prompt } : {}),
    ...(typeof toolCount === "number" ? { tools_count: toolCount } : {})
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function deriveAgentResponseSummaryFromRecords(
  records: Array<Record<string, unknown>>
): Record<string, unknown> | undefined {
  const modelId = extractModelFromRecords(records);
  const telemetryModelId = modelId ? toTelemetryModelId(modelId) : undefined;
  const usage = extractUsageFromRecords(records);
  const text = extractResponseTextFromRecords(records);
  const toolNames = extractToolCallNamesFromRecords(records);
  const summary: Record<string, unknown> = {
    ...(telemetryModelId ? { model: telemetryModelId } : {}),
    ...(modelId && modelId !== telemetryModelId ? { model_id: modelId } : {}),
    ...(text ? { text } : {}),
    ...(usage
      ? {
          usage: {
            ...(typeof usage.inputTokens === "number"
              ? { input_tokens: usage.inputTokens }
              : {}),
            ...(typeof usage.outputTokens === "number"
              ? { output_tokens: usage.outputTokens }
              : {}),
            ...(typeof usage.totalTokens === "number"
              ? { total_tokens: usage.totalTokens }
              : {})
          }
        }
      : {}),
    ...(toolNames.length > 0
      ? {
          tool_calls: toolNames,
          tool_call_count: toolNames.length
        }
      : {})
  };

  if (summary.usage && Object.keys(summary.usage as Record<string, unknown>).length === 0) {
    delete summary.usage;
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function extractLatestUserPromptFromRecords(
  records: Array<Record<string, unknown>>
): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];

    if (!record) {
      continue;
    }

    const prompt =
      extractLatestUserPromptFromInput(record.input) ??
      extractLatestUserPromptFromInput(record.messages) ??
      extractLatestUserPromptFromInput(record.prompt);

    if (prompt) {
      return truncateText(prompt, 1_000);
    }
  }

  return undefined;
}

function extractLatestUserPromptFromInput(value: unknown): string | undefined {
  const inputs = Array.isArray(value)
    ? (value as unknown[])
    : value !== undefined
      ? [value]
      : [];

  for (let index = inputs.length - 1; index >= 0; index -= 1) {
    const entry = inputs[index];

    if (typeof entry === "string") {
      const trimmed = entry.trim();

      if (trimmed.length > 0) {
        return trimmed;
      }

      continue;
    }

    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const role = toStringValue(record.role)?.toLowerCase();

    if (role && role !== "user") {
      continue;
    }

    const text =
      extractTextFromStructuredValue(record.content) ??
      extractTextFromStructuredValue(record.input_text) ??
      extractTextFromStructuredValue(record.text);

    if (text) {
      return text;
    }
  }

  return undefined;
}

function extractTextFromStructuredValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return undefined;
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const extracted = extractTextFromStructuredValue(parsed);

        if (extracted && extracted.trim().length > 0) {
          return extracted.trim();
        }
      } catch {
        // Preserve original string when JSON parsing fails.
      }
    }

    return trimmed;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map(item => extractTextFromStructuredValue(item))
      .filter((item): item is string => Boolean(item && item.trim().length > 0));

    if (parts.length === 0) {
      return undefined;
    }

    const combined = parts.join("\n").trim();
    return combined.length > 0 ? combined : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = toStringValue(record.type)?.toLowerCase();
  const text =
    extractTextFromStructuredValue(record.text) ??
    extractTextFromStructuredValue(record.input_text) ??
    extractTextFromStructuredValue(record.output_text) ??
    extractTextFromStructuredValue(record.content);

  if (!text) {
    return undefined;
  }

  if (!type || type.includes("text") || type === "message") {
    return text;
  }

  return text;
}

function extractToolCountFromRecords(
  records: Array<Record<string, unknown>>
): number | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const tools = records[index]?.tools;

    if (Array.isArray(tools)) {
      return tools.length;
    }
  }

  return undefined;
}

function extractResponseTextFromRecords(
  records: Array<Record<string, unknown>>
): string | undefined {
  let deltaText = "";
  let doneText: string | undefined;
  let completedText: string | undefined;

  for (const record of records) {
    const type = toStringValue(record.type);

    if (type === "response.output_text.delta") {
      const delta = toStringValue(record.delta);

      if (delta) {
        deltaText += delta;
      }

      continue;
    }

    if (type === "response.output_text.done") {
      const done = toStringValue(record.text);

      if (done) {
        doneText = done;
      }

      continue;
    }

    if (type === "response.completed") {
      const response =
        record.response && typeof record.response === "object"
          ? (record.response as Record<string, unknown>)
          : undefined;
      const responseText =
        extractTextFromStructuredValue(response?.output_text) ??
        extractTextFromStructuredValue(response?.output) ??
        extractTextFromStructuredValue(response?.text);

      if (responseText) {
        completedText = responseText;
      }
    }
  }

  const resolved = completedText ?? doneText ?? (deltaText.trim().length > 0 ? deltaText : undefined);

  return resolved ? truncateText(resolved, 2_000) : undefined;
}

function extractToolCallNamesFromRecords(
  records: Array<Record<string, unknown>>
): string[] {
  const names = new Set<string>();

  for (const record of records) {
    const type = toStringValue(record.type);

    if (type === "response.output_item.added") {
      const item =
        record.item && typeof record.item === "object"
          ? (record.item as Record<string, unknown>)
          : undefined;
      const itemType = toStringValue(item?.type);
      const itemName = toStringValue(item?.name);

      if (itemType === "function_call" && itemName) {
        names.add(itemName);
      }
    }

    if (type === "response.completed") {
      const response =
        record.response && typeof record.response === "object"
          ? (record.response as Record<string, unknown>)
          : undefined;
      const output = Array.isArray(response?.output) ? response.output : [];

      for (const outputItem of output) {
        if (!outputItem || typeof outputItem !== "object") {
          continue;
        }

        const outputRecord = outputItem as Record<string, unknown>;
        const itemType = toStringValue(outputRecord.type);
        const itemName = toStringValue(outputRecord.name);

        if (itemType === "function_call" && itemName) {
          names.add(itemName);
        }
      }
    }
  }

  return [...names].slice(0, 8);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 16))}...[truncated]`;
}

function normalizeHookBodyForTelemetry(
  body: string | undefined
): string | undefined {
  if (!body) {
    return body;
  }

  const record = parseJsonRecord(body);

  if (!record) {
    return body;
  }

  let changed = false;

  if (normalizeModelIdentifierInRecord(record)) {
    changed = true;
  }

  const nestedResponse =
    record.response && typeof record.response === "object" &&
    !Array.isArray(record.response)
      ? (record.response as Record<string, unknown>)
      : undefined;

  if (nestedResponse && normalizeModelIdentifierInRecord(nestedResponse)) {
    changed = true;
  }

  if (!changed) {
    return body;
  }

  return JSON.stringify(record);
}

function normalizeModelIdentifierInRecord(
  record: Record<string, unknown>
): boolean {
  const modelValue =
    typeof record.model === "string" ? record.model.trim() : undefined;

  if (!modelValue) {
    return false;
  }

  const parsedModel = parseModelIdentifier(modelValue);
  const rawModelId = parsedModel.modelId ?? modelValue;
  const telemetryModelId = toTelemetryModelId(rawModelId) ?? rawModelId;
  let changed = false;

  if (record.model !== telemetryModelId) {
    record.model = telemetryModelId;
    changed = true;
  }

  if (
    rawModelId !== telemetryModelId &&
    (typeof record.model_id !== "string" || record.model_id.trim().length === 0)
  ) {
    record.model_id = rawModelId;
    changed = true;
  }

  if (parsedModel.provider) {
    if (
      typeof record.model_provider !== "string" ||
      record.model_provider.trim().length === 0
    ) {
      record.model_provider = parsedModel.provider;
      changed = true;
    }

    if (
      typeof record.provider !== "string" ||
      record.provider.trim().length === 0
    ) {
      record.provider = parsedModel.provider;
      changed = true;
    }
  }

  return changed;
}

function parseJsonRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseSseDataBodies(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const payloads: string[] = [];
  let currentDataLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      if (currentDataLines.length > 0) {
        payloads.push(currentDataLines.join("\n"));
        currentDataLines = [];
      }
      continue;
    }

    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const data = trimmed.slice(5).trimStart();

    if (data.length > 0) {
      currentDataLines.push(data);
    }
  }

  if (currentDataLines.length > 0) {
    payloads.push(currentDataLines.join("\n"));
  }

  return payloads.filter(payload => payload !== "[DONE]");
}

function extractModelFromRecords(
  records: Array<Record<string, unknown>>
): string | undefined {
  for (const record of records) {
    const nestedResponse =
      record.response && typeof record.response === "object"
        ? (record.response as Record<string, unknown>)
        : undefined;
    const candidates = [
      record.model_id,
      nestedResponse?.model_id,
      record.model,
      nestedResponse?.model
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== "string" || candidate.trim().length === 0) {
        continue;
      }

      const parsed = parseModelIdentifier(candidate);

      if (parsed.modelId) {
        return parsed.modelId;
      }
    }
  }

  return undefined;
}

function extractProviderFromRecords(
  records: Array<Record<string, unknown>>
): string | undefined {
  for (const record of records) {
    const nestedResponse =
      record.response && typeof record.response === "object"
        ? (record.response as Record<string, unknown>)
        : undefined;
    const candidates = [
      record.provider,
      record.model_provider,
      nestedResponse?.provider,
      nestedResponse?.model_provider,
      record.model,
      nestedResponse?.model
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== "string" || candidate.trim().length === 0) {
        continue;
      }

      const parsed = parseModelIdentifier(candidate);

      if (parsed.provider) {
        return parsed.provider;
      }

      const normalized = normalizeProvider(candidate);

      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

function extractUsageFromRecords(
  records: Array<Record<string, unknown>>
): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | undefined {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;

  for (const record of records) {
    const usage = extractUsageFromRecord(record);

    if (!usage) {
      continue;
    }

    if (inputTokens === undefined && usage.inputTokens !== undefined) {
      inputTokens = usage.inputTokens;
    }

    if (outputTokens === undefined && usage.outputTokens !== undefined) {
      outputTokens = usage.outputTokens;
    }

    if (totalTokens === undefined && usage.totalTokens !== undefined) {
      totalTokens = usage.totalTokens;
    }
  }

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  const resolvedTotalTokens =
    totalTokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(resolvedTotalTokens !== undefined
      ? { totalTokens: resolvedTotalTokens }
      : {})
  };
}

function extractUsageFromRecord(
  record: Record<string, unknown>
): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | undefined {
  const nestedResponse =
    record.response && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : undefined;
  const candidates = [
    record.usage,
    nestedResponse?.usage,
    record,
    nestedResponse
  ];

  for (const candidate of candidates) {
    const usage = parseUsageCandidate(candidate);

    if (usage) {
      return usage;
    }
  }

  return undefined;
}

function parseUsageCandidate(candidate: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const inputTokens =
    toNumberValue(record.input_tokens) ??
    toNumberValue(record.prompt_tokens) ??
    toNumberValue(record.inputTokens) ??
    toNumberValue(record.promptTokens);
  const outputTokens =
    toNumberValue(record.output_tokens) ??
    toNumberValue(record.completion_tokens) ??
    toNumberValue(record.outputTokens) ??
    toNumberValue(record.completionTokens);
  const totalTokens =
    toNumberValue(record.total_tokens) ?? toNumberValue(record.totalTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  const resolvedTotalTokens =
    totalTokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(resolvedTotalTokens !== undefined
      ? { totalTokens: resolvedTotalTokens }
      : {})
  };
}

function parseModelIdentifier(value: string): {
  modelId?: string;
  provider?: string;
} {
  const trimmed = value.trim();

  if (!trimmed) {
    return {};
  }

  const slashParts = trimmed.split("/");

  if (slashParts.length >= 2) {
    const possibleProvider = slashParts[0]?.trim();
    const modelPart = slashParts.slice(1).join("/").trim();

    if (possibleProvider && modelPart) {
      const provider = normalizeProvider(possibleProvider);

      if (provider) {
        return {
          modelId: modelPart,
          provider
        };
      }
    }
  }

  return {
    modelId: trimmed
  };
}

function normalizeProvider(candidate: string): string | undefined {
  const normalized = candidate.trim().toLowerCase();

  if (normalized.includes("openai")) {
    return "openai";
  }

  if (normalized.includes("anthropic")) {
    return "anthropic";
  }

  if (normalized.includes("google") || normalized.includes("gemini")) {
    return "google";
  }

  return undefined;
}

function toTelemetryModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }

  const trimmed = modelId.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const sanitized = trimmed
    .replace(/[.:/\\\s]+/g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized.length > 0 ? sanitized : trimmed;
}

function inferProviderFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  const normalized = url.toLowerCase();

  if (normalized.includes("api.openai.com")) {
    return "openai";
  }

  if (normalized.includes("api.anthropic.com")) {
    return "anthropic";
  }

  if (normalized.includes("generativelanguage.googleapis.com")) {
    return "google";
  }

  return undefined;
}

function inferProviderFromModelId(
  modelId: string | undefined
): string | undefined {
  if (!modelId) {
    return undefined;
  }

  const normalized = modelId.toLowerCase();

  if (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3")
  ) {
    return "openai";
  }

  if (normalized.startsWith("claude-")) {
    return "anthropic";
  }

  if (normalized.startsWith("gemini")) {
    return "google";
  }

  return undefined;
}

function resolveActivityContext(
  spanProcessor: OpenBoxSpanProcessor,
  traceId: string
): {
  activityId: string;
  activityInput?: unknown;
  activityType: string;
  attempt?: number;
  goal?: string;
  runId: string;
  syntheticAgentActivity?: boolean;
  taskQueue: string;
  workflowId: string;
  workflowType: string;
} | undefined {
  const executionContext = getOpenBoxExecutionContext();

  if (
    executionContext?.activityId &&
    executionContext.activityType &&
    executionContext.workflowId &&
    executionContext.workflowType &&
    executionContext.runId
  ) {
    const spanActivityContext = spanProcessor.getActivityContext(
      executionContext.workflowId,
      executionContext.activityId
    );
    const spanGoal = toStringValue(spanActivityContext?.goal);
    const resolvedGoal = spanGoal ?? executionContext.goal;

    return {
      activityId: executionContext.activityId,
      ...(spanActivityContext &&
      Object.prototype.hasOwnProperty.call(spanActivityContext, "activity_input")
        ? {
            activityInput: spanActivityContext.activity_input
          }
        : {}),
      activityType: executionContext.activityType,
      ...(typeof resolvedGoal === "string" && resolvedGoal.length > 0
        ? {
            goal: resolvedGoal
          }
        : {}),
      runId: executionContext.runId,
      taskQueue: executionContext.taskQueue ?? "mastra",
      workflowId: executionContext.workflowId,
      workflowType: executionContext.workflowType,
      ...(typeof executionContext.attempt === "number"
        ? { attempt: executionContext.attempt }
        : {})
    };
  }

  if (
    executionContext?.source === "agent" &&
    executionContext.workflowId &&
    executionContext.workflowType &&
    executionContext.runId
  ) {
    return {
      activityId: `${executionContext.workflowId}::agent-llm::${executionContext.runId}`,
      activityType: "agentLlmCompletion",
      ...(executionContext.goal ? { goal: executionContext.goal } : {}),
      runId: executionContext.runId,
      syntheticAgentActivity: true,
      taskQueue: executionContext.taskQueue ?? "mastra",
      workflowId: executionContext.workflowId,
      workflowType: executionContext.workflowType,
      ...(typeof executionContext.attempt === "number"
        ? { attempt: executionContext.attempt }
        : {})
    };
  }

  const spanContext = spanProcessor.getActivityContextByTrace(traceId);

  if (!spanContext) {
    return undefined;
  }

  const activityId = toStringValue(spanContext.activity_id);
  const activityType = toStringValue(spanContext.activity_type);
  const workflowId = toStringValue(spanContext.workflow_id);
  const workflowType = toStringValue(spanContext.workflow_type);
  const runId = toStringValue(spanContext.run_id);

  if (!activityId || !activityType || !workflowId || !workflowType || !runId) {
    return undefined;
  }
  const spanGoal = toStringValue(spanContext.goal);

  return {
    activityId,
    activityInput: spanContext.activity_input,
    activityType,
    ...(spanGoal ? { goal: spanGoal } : {}),
    runId,
    taskQueue: toStringValue(spanContext.task_queue) ?? "mastra",
    workflowId,
    workflowType,
    ...(typeof spanContext.attempt === "number"
      ? { attempt: spanContext.attempt }
      : {})
  };
}

function createHookSpan(input: {
  attributes: Record<string, unknown>;
  endTimeNs: number;
  error?: string | undefined;
  fileMode?: string | undefined;
  fileOperation?: string | undefined;
  filePath?: string | undefined;
  functionArgs?: unknown;
  functionModule?: string | undefined;
  functionName?: string | undefined;
  functionResult?: unknown;
  hookType: string;
  httpMethod?: string | undefined;
  httpStatusCode?: number | undefined;
  httpUrl?: string | undefined;
  kind: string;
  name: string;
  parentSpanId?: string | undefined;
  requestBody?: string | undefined;
  requestHeaders?: Record<string, string> | undefined;
  responseBody?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
  rowcount?: number | undefined;
  semanticType: string;
  serverAddress?: string | undefined;
  serverPort?: number | undefined;
  spanId?: string | undefined;
  stage: "completed" | "started";
  startTimeNs: number;
  bytesRead?: number | undefined;
  bytesWritten?: number | undefined;
  data?: string | undefined;
  dbName?: string | undefined;
  dbOperation?: string | undefined;
  dbStatement?: string | undefined;
  dbSystem?: string | undefined;
  linesCount?: number | undefined;
  traceId: string;
}): Record<string, unknown> {
  const span: Record<string, unknown> = {
    attributes: input.attributes,
    events: [],
    hook_type: input.hookType,
    kind: input.kind,
    name: input.name,
    semantic_type: input.semanticType,
    span_id: normalizeHexId(input.spanId, 16),
    stage: input.stage,
    start_time: input.startTimeNs,
    status: {
      code: input.error ? "ERROR" : "OK",
      ...(input.error ? { description: input.error } : {})
    },
    trace_id: normalizeHexId(input.traceId, 32)
  };

  if (input.stage === "completed") {
    span.end_time = input.endTimeNs;
    span.duration_ns = Math.max(0, input.endTimeNs - input.startTimeNs);
  }

  if (input.parentSpanId !== undefined) {
    span.parent_span_id = normalizeHexId(input.parentSpanId, 16);
  }

  if (input.error !== undefined) {
    span.error = input.error;
  }

  if (input.requestBody !== undefined) {
    span.request_body = input.requestBody;
  }

  if (input.stage === "completed" && input.responseBody !== undefined) {
    span.response_body = input.responseBody;
  }

  if (input.requestHeaders !== undefined) {
    span.request_headers = input.requestHeaders;
  }

  if (input.stage === "completed" && input.responseHeaders !== undefined) {
    span.response_headers = input.responseHeaders;
  }

  if (input.hookType === "http_request") {
    if (input.httpMethod !== undefined) {
      span.http_method = input.httpMethod;
    }

    if (input.httpUrl !== undefined) {
      span.http_url = input.httpUrl;
    }

    if (input.stage === "completed" && input.httpStatusCode !== undefined) {
      span.http_status_code = input.httpStatusCode;
    }
  } else if (input.hookType === "db_query") {
    if (input.dbSystem !== undefined) {
      span.db_system = input.dbSystem;
    }

    if (input.dbName !== undefined) {
      span.db_name = input.dbName;
    }

    if (input.dbOperation !== undefined) {
      span.db_operation = input.dbOperation;
    }

    if (input.dbStatement !== undefined) {
      span.db_statement = input.dbStatement;
    }

    if (input.serverAddress !== undefined) {
      span.server_address = input.serverAddress;
    }

    if (input.serverPort !== undefined) {
      span.server_port = input.serverPort;
    }

    if (input.stage === "completed" && input.rowcount !== undefined) {
      span.rowcount = input.rowcount;
    }
  } else if (input.hookType === "file_operation") {
    if (input.filePath !== undefined) {
      span.file_path = input.filePath;
    }

    if (input.fileMode !== undefined) {
      span.file_mode = input.fileMode;
    }

    if (input.fileOperation !== undefined) {
      span.file_operation = input.fileOperation;
    }

    if (input.stage === "completed" && input.data !== undefined) {
      span.data = input.data;
    }

    if (input.stage === "completed" && input.bytesRead !== undefined) {
      span.bytes_read = input.bytesRead;
    }

    if (input.stage === "completed" && input.bytesWritten !== undefined) {
      span.bytes_written = input.bytesWritten;
    }

    if (input.stage === "completed" && input.linesCount !== undefined) {
      span.lines_count = input.linesCount;
    }
  } else if (input.hookType === "function_call") {
    if (input.functionName !== undefined) {
      span.function = input.functionName;
    }

    if (input.functionModule !== undefined) {
      span.module = input.functionModule;
    }

    if (input.functionArgs !== undefined) {
      span.args = sanitizeForGovernancePayload(input.functionArgs);
    }

    if (input.stage === "completed" && input.functionResult !== undefined) {
      span.result = sanitizeForGovernancePayload(input.functionResult);
    }
  }

  return span;
}

function normalizeHexId(
  value: string | undefined,
  width: number
): string {
  const base = (value ?? randomUUID().replaceAll("-", "")).toLowerCase();
  const filtered = base.replace(/[^a-f0-9]/g, "");

  if (filtered.length >= width) {
    return filtered.slice(0, width);
  }

  return filtered.padEnd(width, "0");
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toNumberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function getSpanAttribute(
  span: {
    attributes?: Record<string, unknown>;
  },
  key: string
): unknown {
  return span.attributes?.[key];
}

function parseDbOperation(statement: string | undefined): string | undefined {
  if (!statement) {
    return undefined;
  }

  const trimmed = statement.trim();

  if (!trimmed) {
    return undefined;
  }

  const [operation] = trimmed.split(/\s+/);

  return operation?.toUpperCase();
}

function sanitizeForGovernancePayload(value: unknown): unknown {
  const seen = new WeakSet<object>();

  try {
    return JSON.parse(
      JSON.stringify(value, (_key, entry: unknown) => {
        if (typeof entry === "bigint") {
          return entry.toString();
        }

        if (typeof entry === "function") {
          return `[function ${entry.name || "anonymous"}]`;
        }

        if (typeof entry === "symbol") {
          return entry.toString();
        }

        if (entry instanceof Error) {
          return {
            message: entry.message,
            name: entry.name,
            stack: entry.stack
          };
        }

        if (entry && typeof entry === "object") {
          if (seen.has(entry as object)) {
            return "[circular]";
          }

          seen.add(entry as object);
        }

        return entry;
      })
    );
  } catch {
    return String(value);
  }
}

function loadInstrumentation(
  definition: {
    exportName: string;
    moduleName: string;
  },
  config?: unknown
): Instrumentation<InstrumentationConfig> {
  const require = createRequire(import.meta.url);
  const moduleExports = require(definition.moduleName) as Record<
    string,
    new (config?: unknown) => Instrumentation<InstrumentationConfig>
  >;
  const InstrumentationConstructor = moduleExports[definition.exportName];

  if (typeof InstrumentationConstructor !== "function") {
    throw new Error(
      `Instrumentation export ${definition.exportName} was not found in ${definition.moduleName}`
    );
  }

  return new InstrumentationConstructor(config);
}
