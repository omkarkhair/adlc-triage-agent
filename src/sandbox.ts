import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { MAX_LIFETIME_MS, planLifetime } from "./lifetime";

const STARTED_AT = "lifetime:startedAt";
const EXPIRE = "expireLifetime";

/**
 * The Cloudflare Sandbox with a hard lifetime. The SDK's `sleepAfter` is an idle timer that a
 * hung command keeps renewing, so a stuck run would keep its container forever. This class
 * destroys the container MAX_LIFETIME_MS after it started, busy or not. Container schedules run
 * from the Durable Object alarm before its activity check, so the deadline cannot be postponed.
 */
export class Sandbox extends BaseSandbox {
  constructor(...args: ConstructorParameters<typeof BaseSandbox>) {
    super(...args);
    this.ctx.blockConcurrencyWhile(() => this.armLifetime());
  }

  private async armLifetime(): Promise<void> {
    if (!this.ctx.container?.running) {
      return;
    }
    const startedAt = await this.ctx.storage.get<number>(STARTED_AT);
    const plan = planLifetime(startedAt, Date.now());
    this.deleteSchedules(EXPIRE);
    if (plan.action === "expire") {
      await this.schedule(0, EXPIRE, { legacy: plan.legacy });
    } else {
      await this.schedule(plan.delaySeconds, EXPIRE, { legacy: false });
    }
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    await this.ctx.storage.put(STARTED_AT, Date.now());
    this.deleteSchedules(EXPIRE);
    await this.schedule(MAX_LIFETIME_MS / 1000, EXPIRE, { legacy: false });
  }

  override async onStop(params: Parameters<BaseSandbox["onStop"]>[0]): Promise<void> {
    this.deleteSchedules(EXPIRE);
    await this.ctx.storage.delete(STARTED_AT);
    await super.onStop(params);
  }

  async expireLifetime(payload?: { legacy?: boolean }): Promise<void> {
    if (!this.ctx.container?.running) {
      return;
    }
    const startedAt = await this.ctx.storage.get<number>(STARTED_AT);
    console.log(
      JSON.stringify({
        event: "sandbox.expired",
        objectId: this.ctx.id.toString(),
        ageMs: startedAt === undefined ? null : Date.now() - startedAt,
        legacy: payload?.legacy === true,
      }),
    );
    await this.destroy();
  }
}
