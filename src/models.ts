import { createProvider, type Provider } from "@earendil-works/pi-ai";
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
  setProvider(cloudflareBindingProvider({ binding: env.AI, gateway: { id: env.AI_GATEWAY_ID } }));
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
    api: openAICompletionsApi(),
  });
}
