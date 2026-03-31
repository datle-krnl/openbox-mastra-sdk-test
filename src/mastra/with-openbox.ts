import type { Mastra } from "@mastra/core/mastra";

import { OpenBoxClient } from "../client/index.js";
import {
  parseOpenBoxConfig,
  setOpenBoxConfig,
  type OpenBoxConfig,
  type OpenBoxConfigInput
} from "../config/index.js";
import { setupOpenBoxOpenTelemetry, type OpenBoxTelemetryController } from "../otel/index.js";
import { OpenBoxSpanProcessor } from "../span/index.js";
import { OpenBoxConfigError } from "../types/index.js";
import { wrapAgent } from "./wrap-agent.js";
import { wrapTool, type WrapToolOptions } from "./wrap-tool.js";
import { wrapWorkflow } from "./wrap-workflow.js";

const OPENBOX_RUNTIME = Symbol.for("openbox.mastra.runtime");
const OPENBOX_WITH_OPENBOX = Symbol.for("openbox.mastra.withOpenBox");
const OPENBOX_AGENT_LOCAL_PATCH = Symbol.for("openbox.mastra.withOpenBox.agentLocal");
const OPENBOX_MASTRA_PATCH = Symbol.for("openbox.mastra.withOpenBox.mastra");

type GovernableMastra = Mastra;
type ToolRecord = Record<string, unknown>;
type WorkflowRecord = Record<string, unknown>;

interface AgentWithLocalRegistries extends Record<PropertyKey, unknown> {
  __setTools?: ((tools: ToolRecord) => void) | undefined;
  listTools?: ((...args: unknown[]) => ToolRecord | Promise<ToolRecord>) | undefined;
  listWorkflows?: ((...args: unknown[]) => WorkflowRecord | Promise<WorkflowRecord>) | undefined;
}

export interface WithOpenBoxOptions extends OpenBoxConfigInput {
  client?: OpenBoxClient | undefined;
  dbLibraries?: ReadonlySet<string> | undefined;
  fetch?: typeof fetch | undefined;
  fileSkipPatterns?: string[] | undefined;
  ignoredUrls?: string[] | undefined;
  spanProcessor?: OpenBoxSpanProcessor | undefined;
}

export interface OpenBoxRuntime extends WrapToolOptions {
  shutdown: () => Promise<void>;
  telemetry: OpenBoxTelemetryController;
}

export async function withOpenBox<TTarget extends object>(
  target: TTarget,
  options: WithOpenBoxOptions = {}
): Promise<TTarget> {
  const resolved = resolveMastraTarget(target);
  const existingRuntime = getOpenBoxRuntime(resolved.mastra);

  if (existingRuntime) {
    attachRuntime(target, existingRuntime);
    return target;
  }

  const runtime = await createRuntime(options);

  patchMastra(resolved.mastra, runtime);
  wrapTopLevelRegistries(resolved.mastra, runtime);
  await hydrateAgentLocalRegistries(resolved.mastra, runtime);

  defineHiddenProperty(resolved.mastra, OPENBOX_WITH_OPENBOX, true);
  attachRuntime(target, runtime);

  return target;
}

export function getOpenBoxRuntime(target: unknown): OpenBoxRuntime | undefined {
  if (!target || typeof target !== "object") {
    return undefined;
  }

  const directRuntime = (target as Record<PropertyKey, unknown>)[
    OPENBOX_RUNTIME
  ] as OpenBoxRuntime | undefined;

  if (directRuntime) {
    return directRuntime;
  }

  const nestedMastra = (target as { mastra?: unknown }).mastra;

  if (looksLikeMastra(nestedMastra)) {
    return (nestedMastra as unknown as Record<PropertyKey, unknown>)[
      OPENBOX_RUNTIME
    ] as OpenBoxRuntime | undefined;
  }

  return undefined;
}

async function createRuntime(options: WithOpenBoxOptions): Promise<OpenBoxRuntime> {
  const config = parseOpenBoxConfig(options);
  const client =
    options.client ??
    new OpenBoxClient(buildClientOptions(config, options.fetch));

  if (config.validate) {
    await client.validateApiKey();
  }

  setOpenBoxConfig(config);

  const ignoredUrls = [...new Set([config.apiUrl, ...(options.ignoredUrls ?? [])])];
  const spanProcessor =
    options.spanProcessor ??
    new OpenBoxSpanProcessor({
      ignoredUrlPrefixes: ignoredUrls
    });
  const telemetry = setupOpenBoxOpenTelemetry({
    captureHttpBodies: config.httpCapture,
    dbLibraries: options.dbLibraries,
    fileSkipPatterns: options.fileSkipPatterns,
    governanceClient: client,
    ignoredUrls,
    instrumentDatabases: config.instrumentDatabases,
    instrumentFileIo: config.instrumentFileIo,
    onHookApiError: config.onApiError,
    spanProcessor
  });
  let shutdownComplete = false;

  return {
    client,
    config,
    async shutdown() {
      if (shutdownComplete) {
        return;
      }

      shutdownComplete = true;
      await telemetry.shutdown();
    },
    spanProcessor,
    telemetry
  };
}

function resolveMastraTarget(target: object): { mastra: GovernableMastra } {
  if (looksLikeMastra(target)) {
    return {
      mastra: target
    };
  }

  const nestedMastra = (target as { mastra?: unknown }).mastra;

  if (looksLikeMastra(nestedMastra)) {
    return {
      mastra: nestedMastra
    };
  }

  throw new OpenBoxConfigError(
    "withOpenBox() expected a Mastra instance or an app object with a 'mastra' property."
  );
}

function patchMastra(mastra: GovernableMastra, runtime: OpenBoxRuntime): void {
  const baseMastra = mastra as GovernableMastra & Record<PropertyKey, unknown>;

  if (baseMastra[OPENBOX_MASTRA_PATCH]) {
    return;
  }

  const originalAddTool = mastra.addTool.bind(mastra);
  const originalAddWorkflow = mastra.addWorkflow.bind(mastra);
  const originalAddAgent = mastra.addAgent.bind(mastra);

  mastra.addTool = ((tool: Parameters<typeof originalAddTool>[0], key?: string) => {
    originalAddTool(wrapTool(tool, runtime), key);
  }) as GovernableMastra["addTool"];

  mastra.addWorkflow = ((
    workflow: Parameters<typeof originalAddWorkflow>[0],
    key?: string
  ) => {
    originalAddWorkflow(wrapWorkflow(workflow, runtime), key);
  }) as GovernableMastra["addWorkflow"];

  mastra.addAgent = ((
    agent: Parameters<typeof originalAddAgent>[0],
    key?: string,
    options?: Parameters<typeof originalAddAgent>[2]
  ) => {
    const wrappedAgent = patchAgent(agent, runtime);
    originalAddAgent(wrappedAgent, key, options);

    void hydrateAgentLocalRegistriesForAgent(wrappedAgent, runtime);
  }) as GovernableMastra["addAgent"];

  defineHiddenProperty(baseMastra, OPENBOX_MASTRA_PATCH, true);
}

function wrapTopLevelRegistries(mastra: GovernableMastra, runtime: OpenBoxRuntime): void {
  wrapToolRecord(mastra.listTools(), runtime);
  wrapWorkflowRecord(mastra.listWorkflows(), runtime);

  const agents = mastra.listAgents();

  for (const [key, agent] of Object.entries(agents)) {
    agents[key] = patchAgent(agent, runtime);
  }
}

async function hydrateAgentLocalRegistries(
  mastra: GovernableMastra,
  runtime: OpenBoxRuntime
): Promise<void> {
  const agents = mastra.listAgents();

  await Promise.all(
    Object.values(agents).map(agent => hydrateAgentLocalRegistriesForAgent(agent, runtime))
  );
}

async function hydrateAgentLocalRegistriesForAgent(
  agent: unknown,
  runtime: OpenBoxRuntime
): Promise<void> {
  const patchedAgent = patchAgent(agent, runtime) as AgentWithLocalRegistries;

  if (patchedAgent.listTools) {
    const tools = await patchedAgent.listTools();
    applyAgentToolRecord(patchedAgent, tools, runtime);
  }

  if (patchedAgent.listWorkflows) {
    const workflows = await patchedAgent.listWorkflows();
    wrapWorkflowRecord(workflows, runtime);
  }
}

function patchAgent<TAgent>(agent: TAgent, runtime: OpenBoxRuntime): TAgent {
  const wrappedAgent = wrapAgent(agent, runtime);
  const baseAgent = wrappedAgent as AgentWithLocalRegistries;

  if (baseAgent[OPENBOX_AGENT_LOCAL_PATCH]) {
    return wrappedAgent;
  }

  const originalSetTools = baseAgent.__setTools?.bind(baseAgent);
  const originalListTools = baseAgent.listTools?.bind(baseAgent);
  const originalListWorkflows = baseAgent.listWorkflows?.bind(baseAgent);

  if (originalSetTools) {
    baseAgent.__setTools = (tools: ToolRecord) => {
      const wrappedTools = wrapToolRecord(tools, runtime);
      originalSetTools(wrappedTools);
    };
  }

  if (originalListTools) {
    baseAgent.listTools = (...args: unknown[]) => {
      const result = originalListTools(...args);

      if (isPromise(result)) {
        return result.then(tools => applyAgentToolRecord(baseAgent, tools, runtime));
      }

      return applyAgentToolRecord(baseAgent, result, runtime);
    };
  }

  if (originalListWorkflows) {
    baseAgent.listWorkflows = (...args: unknown[]) => {
      const result = originalListWorkflows(...args);

      if (isPromise(result)) {
        return result.then(workflows => wrapWorkflowRecord(workflows, runtime));
      }

      return wrapWorkflowRecord(result, runtime);
    };
  }

  defineHiddenProperty(baseAgent, OPENBOX_AGENT_LOCAL_PATCH, true);

  return wrappedAgent;
}

function applyAgentToolRecord(
  agent: AgentWithLocalRegistries,
  tools: ToolRecord,
  runtime: OpenBoxRuntime
): ToolRecord {
  const wrappedTools = wrapToolRecord(tools, runtime);

  agent.__setTools?.(wrappedTools);

  return wrappedTools;
}

function wrapToolRecord<TRecord extends ToolRecord | undefined>(
  tools: TRecord,
  runtime: OpenBoxRuntime
): TRecord {
  if (!tools) {
    return tools;
  }

  for (const [key, tool] of Object.entries(tools)) {
    tools[key] = wrapTool(tool, runtime);
  }

  return tools;
}

function wrapWorkflowRecord<TRecord extends WorkflowRecord | undefined>(
  workflows: TRecord,
  runtime: OpenBoxRuntime
): TRecord {
  if (!workflows) {
    return workflows;
  }

  for (const [key, workflow] of Object.entries(workflows)) {
    workflows[key] = wrapWorkflow(workflow, runtime);
  }

  return workflows;
}

function attachRuntime(
  target: object,
  runtime: OpenBoxRuntime
): void {
  defineHiddenProperty(target, OPENBOX_RUNTIME, runtime);

  const nestedMastra = (target as { mastra?: unknown }).mastra;

  if (!looksLikeMastra(target) && looksLikeMastra(nestedMastra)) {
    defineHiddenProperty(nestedMastra, OPENBOX_RUNTIME, runtime);
  }
}

function defineHiddenProperty(
  target: object,
  key: PropertyKey,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    value,
    writable: true
  });
}

function looksLikeMastra(value: unknown): value is GovernableMastra {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.addAgent === "function" &&
    typeof candidate.addTool === "function" &&
    typeof candidate.addWorkflow === "function" &&
    typeof candidate.listAgents === "function" &&
    typeof candidate.listTools === "function" &&
    typeof candidate.listWorkflows === "function"
  );
}

function buildClientOptions(
  config: OpenBoxConfig,
  customFetch?: typeof fetch
): ConstructorParameters<typeof OpenBoxClient>[0] {
  return {
    ...(customFetch ? { fetch: customFetch } : {}),
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    evaluateMaxRetries: config.evaluateMaxRetries,
    evaluateRetryBaseDelayMs: config.evaluateRetryBaseDelayMs,
    onApiError: config.onApiError,
    timeoutSeconds: config.governanceTimeout
  };
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<T>).then === "function"
  );
}
