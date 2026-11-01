import { createProvider, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { setProvider } from "@flue/runtime";
import {
  type CloudflareAIBinding,
  cloudflareBindingProvider,
} from "@flue/runtime/cloudflare/workers-ai";

export const WORKERS_AI_MODEL = "@cf/zai-org/glm-4.7-flash";
export const SHARED_GATEWAY_PROVIDER = "cloudflare-ai-gateway";
const SHARED_MODEL_ID = `workers-ai/${WORKERS_AI_MODEL}`;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** Longest one model request (including its streamed response) may take before it is cut off. */
export const MODEL_REQUEST_TIMEOUT_MS = 120_000;

export interface ModelEnv {
  AI_GATEWAY_ID: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
}

export interface SharedGateway {
  accountId: string;
  gatewayId: string;
  token: string;
}

export function registerModelProviders(env: ModelEnv & { AI: CloudflareAIBinding }): void {
  setProvider(
    cloudflareBindingProvider({
      binding: withModelTimeout(env.AI),
      gateway: { id: env.AI_GATEWAY_ID },
    }),
  );
  const shared = sharedGatewayFrom(env);
  if (shared) {
    setProvider(sharedGatewayProvider(shared));
  }
}

export function modelFor(env: ModelEnv): string {
  return sharedGatewayFrom(env)
    ? `${SHARED_GATEWAY_PROVIDER}/${SHARED_MODEL_ID}`
    : `cloudflare/${WORKERS_AI_MODEL}`;
}

export function sharedGatewayFrom(env: ModelEnv): SharedGateway | null {
  const token = env.AI_GATEWAY_TOKEN?.trim();
  const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    return null;
  }
  if (!ACCOUNT_ID.test(accountId)) {
    throw new Error("AI_GATEWAY_ACCOUNT_ID must be a 32-character Cloudflare account id");
  }
  return { accountId, gatewayId: env.AI_GATEWAY_ID, token };
}

export function sharedGatewayProvider(shared: SharedGateway): Provider {
  const baseUrl = `https://gateway.ai.cloudflare.com/v1/${shared.accountId}/${encodeURIComponent(shared.gatewayId)}/compat`;
  const models = cloudflareAIGatewayProvider()
    .getModels()
    .filter((model) => model.id === SHARED_MODEL_ID && model.api === "openai-completions")
    .map((model) => ({ ...model, baseUrl }));
  if (models.length === 0) {
    throw new Error(`The pi-ai catalog has no ${SHARED_MODEL_ID} model for AI Gateway`);
  }
  return createProvider({
    id: SHARED_GATEWAY_PROVIDER,
    name: "Shared Cloudflare AI Gateway",
    models,
    auth: {
      apiKey: {
        name: "AI_GATEWAY_TOKEN",
        resolve: async () => ({
          auth: {
            headers: {
              "cf-aig-authorization": `Bearer ${shared.token}`,
              Authorization: null,
              "x-api-key": null,
            },
          },
          source: "AI_GATEWAY_TOKEN",
        }),
      },
    },
    api: withFetchTimeout(openAICompletionsApi()),
  });
}

/**
 * Runs `start` but fails with "Model request timed out" once `timeoutMs` passes. When `start`
 * returns a streamed Response, the deadline also covers reading its body, so a model that keeps
 * a stream open forever is cut off too. The message contains "timed out", which Flue treats as
 * a retryable model error. Without this a stuck request holds the agent until its durability
 * timeout.
 */
export async function withDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = MODEL_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Model request timed out after ${Math.round(timeoutMs / 1000)}s`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  expired.catch(() => {});
  const stop = () => clearTimeout(timer);

  let result: T;
  try {
    result = await Promise.race([start(controller.signal), expired]);
  } catch (error) {
    stop();
    throw error;
  }
  if (!(result instanceof Response) || !result.body) {
    stop();
    return result;
  }
  const reader = result.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const chunk = await Promise.race([reader.read(), expired]);
        if (chunk.done) {
          stop();
          stream.close();
        } else {
          stream.enqueue(chunk.value);
        }
      } catch (error) {
        stop();
        reader.cancel(error).catch(() => {});
        stream.error(error);
      }
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
  });
  return new Response(body, result) as T;
}

function eitherSignal(signal: unknown, deadline: AbortSignal): AbortSignal {
  return signal instanceof AbortSignal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** Wraps the Workers AI binding so every `run` call gets the model request deadline. */
export function withModelTimeout(
  binding: CloudflareAIBinding,
  timeoutMs: number = MODEL_REQUEST_TIMEOUT_MS,
): CloudflareAIBinding {
  return {
    run: (model, inputs, options) =>
      withDeadline(
        (deadline) =>
          binding.run(model, inputs, {
            ...options,
            signal: eitherSignal(options?.signal, deadline),
          }),
        timeoutMs,
      ),
  };
}

/** Gives the shared-gateway API a fetch with the model request deadline. */
function withFetchTimeout(api: ProviderStreams): ProviderStreams {
  const timedFetch: typeof fetch = (input, init) =>
    withDeadline((deadline) =>
      fetch(input, { ...init, signal: eitherSignal(init?.signal, deadline) }),
    );
  return {
    stream: (model, context, options) =>
      api.stream(model, context, { ...options, fetch: options?.fetch ?? timedFetch }),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, { ...options, fetch: options?.fetch ?? timedFetch }),
  };
}
