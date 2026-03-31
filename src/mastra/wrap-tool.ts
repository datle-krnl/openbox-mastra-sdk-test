import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";

import {
  executeGovernedActivity,
  type ToolExecutionContextLike
} from "../governance/activity-runtime.js";
import type { OpenBoxClient } from "../client/index.js";
import type { OpenBoxConfig } from "../config/index.js";
import type { OpenBoxSpanProcessor } from "../span/index.js";

export interface WrapToolOptions {
  client: OpenBoxClient;
  config: OpenBoxConfig;
  spanProcessor: OpenBoxSpanProcessor;
}

const OPENBOX_WRAPPED_TOOL = Symbol.for("openbox.mastra.wrapTool");

type AnyToolAction = {
  description: string;
  execute?: (
    inputData: any,
    context: ToolExecutionContext<any, any, any>
  ) => Promise<any> | undefined;
  id: string;
  inputSchema?: unknown | undefined;
  mastra?: unknown | undefined;
  mcp?: unknown | undefined;
  outputSchema?: unknown | undefined;
  providerOptions?: Record<string, Record<string, unknown>> | undefined;
  requestContextSchema?: unknown | undefined;
  requireApproval?: boolean | undefined;
  resumeSchema?: unknown | undefined;
  suspendSchema?: unknown | undefined;
  toModelOutput?: ((output: unknown) => unknown) | undefined;
};

export function wrapTool<TTool>(
  tool: TTool,
  options: WrapToolOptions
): TTool {
  const baseTool = tool as AnyToolAction & Record<PropertyKey, unknown>;

  if (baseTool[OPENBOX_WRAPPED_TOOL]) {
    return tool;
  }

  const wrapped = createTool({
    description: baseTool.description,
    execute: baseTool.execute
      ? async (input, context) => {
          return executeGovernedActivity({
            dependencies: {
              client: options.client,
              config: options.config,
              spanProcessor: options.spanProcessor
            },
            execute: async governedInput => {
              return baseTool.execute?.(governedInput, context);
            },
            input,
            runtimeContext: context as ToolExecutionContextLike,
            type: baseTool.id
          });
        }
      : undefined,
    id: baseTool.id,
    inputSchema: baseTool.inputSchema as Parameters<typeof createTool>[0]["inputSchema"],
    mastra: baseTool.mastra as Parameters<typeof createTool>[0]["mastra"],
    mcp: baseTool.mcp as Parameters<typeof createTool>[0]["mcp"],
    outputSchema: baseTool.outputSchema as Parameters<typeof createTool>[0]["outputSchema"],
    providerOptions: baseTool.providerOptions,
    requestContextSchema: baseTool.requestContextSchema as Parameters<
      typeof createTool
    >[0]["requestContextSchema"],
    requireApproval: baseTool.requireApproval,
    resumeSchema: baseTool.resumeSchema as Parameters<typeof createTool>[0]["resumeSchema"],
    suspendSchema: baseTool.suspendSchema as Parameters<typeof createTool>[0]["suspendSchema"],
    toModelOutput: baseTool.toModelOutput
  } as Parameters<typeof createTool>[0]);

  Object.defineProperty(wrapped, OPENBOX_WRAPPED_TOOL, {
    enumerable: false,
    value: true
  });

  return wrapped as TTool;
}
