import { type Contract, type Signer, ZeroAddress } from "ethers";

import type { Env } from "./env";
import { type PartnerTables, type Upline } from "./oracle";

export interface Actor {
  name: string;
  signer: Signer;
  address: string;
}

/** A stake the scenario opened, kept for the later steps (accrual, claims, closes). */
export interface StakeRef {
  id: bigint;
  owner: string;
  pool: number;
  principal: bigint;
  entryUsdt: bigint;
  openedAt: number;
  version: bigint;
  vexMark: bigint;
  usdtMark: bigint;
}

export interface PoolPlan {
  id: number;
  code: string;
  /** VEX of the smallest stake the pool takes. */
  vex: bigint;
  /** Why the pool is not staked in (a real chain condition), undefined when it is. */
  skip?: string;
}

/** State shared by the steps of one run: the actors, the stakes they opened and a few chain readers. */
export class World {
  readonly actors = new Map<string, Actor>();
  readonly stakes = new Map<string, StakeRef[]>();
  /** Free-form notes the later steps read (ids, timestamps). */
  readonly memo = new Map<string, string>();
  /** The pools the run stakes in, decided by the preflight (launched, enabled, affordable). */
  plan: PoolPlan[] = [];
  private tables?: PartnerTables;

  constructor(readonly env: Env) {}

  addActor(name: string, signer: Signer, address: string): Actor {
    const actor = { name, signer, address };
    this.actors.set(name, actor);
    return actor;
  }

  actor(name: string): Actor {
    const a = this.actors.get(name);
    if (!a) throw new Error(`actor ${name} does not exist yet`);
    return a;
  }

  stakesOf(name: string): StakeRef[] {
    return this.stakes.get(name) ?? [];
  }

  /** `contract` connected to the actor, to send. */
  as(contract: Contract, actor: Actor): Contract {
    return this.env.as(contract, actor.signer);
  }

  /** Transaction overrides (the flat testnet gas price on a live chain). */
  ov(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...this.env.fees, ...extra };
  }

  async vexPrice(): Promise<bigint> {
    return BigInt(await this.env.c.priceFeed.vexPrice());
  }

  async balanceOf(token: Contract, address: string): Promise<bigint> {
    return BigInt(await token.balanceOf(address));
  }

  async bnbBalance(address: string): Promise<bigint> {
    return this.env.provider.getBalance(address);
  }

  async partnerTables(): Promise<PartnerTables> {
    if (this.tables) return this.tables;
    const n = this.env.c.network;
    const [nc, lr] = await n.tierLevels();
    const [bfBps, bfLevels] = await n.backFlow();
    this.tables = {
      ncRates: [...(await n.ncRates())].map(BigInt),
      lrRates: [...(await n.lrRates())].map(BigInt),
      ncLevels: [...nc].map(BigInt),
      lrLevels: [...lr].map(BigInt),
      bfBps: BigInt(bfBps),
      bfLevels: BigInt(bfLevels),
    };
    return this.tables;
  }

  /** The sponsors above `address`, nearest first, with the fields the partner programs read. */
  async upline(address: string, depth = 15): Promise<Upline[]> {
    const n = this.env.c.network;
    const out: Upline[] = [];
    let node = String(await n.sponsorOf(address));
    while (node !== ZeroAddress && out.length < depth) {
      const m = await n.memberOf(node);
      out.push({
        address: node,
        frozen: Boolean(m.frozen),
        licenseActive: Boolean(m.licenseActive),
        tier: Number(m.tier),
        capBase: BigInt(m.capBase),
        capUsed: BigInt(m.capUsed),
      });
      node = String(m.sponsor);
    }
    return out;
  }

  /** Cumulative partner credits (VEX, USDT) of each address. */
  async credits(addresses: string[]): Promise<Map<string, { vex: bigint; usdt: bigint }>> {
    const out = new Map<string, { vex: bigint; usdt: bigint }>();
    for (const a of addresses) {
      const t = await this.env.c.network.bonusTotals(a);
      out.set(a.toLowerCase(), { vex: BigInt(t[0]), usdt: BigInt(t[1]) });
    }
    return out;
  }
}
