import type { Contract, Interface, TransactionReceipt } from "ethers";

/** The outcome of one step of the E2E scenario (docs/testnet.md "E2E runner"). */
export type StepStatus = "PASS" | "FAIL" | "SKIPPED" | "NEEDS-OPERATOR" | "BLOCKED";

export interface TxRecord {
  label: string;
  from: string;
  hash: string;
  block: number;
  gasUsed: string;
  /** gasUsed x effective gas price, in wei. */
  feeWei: string;
}

export interface CheckRecord {
  label: string;
  ok: boolean;
  expected?: string;
  actual?: string;
}

/** The call a key holder that the runner does not have (OPERATOR / Safe / timelock) would make. */
export interface OperatorCall {
  from: string;
  contract: string;
  address: string;
  function: string;
  args: string[];
  calldata: string;
  note?: string;
}

export interface StepResult {
  id: string;
  title: string;
  status: StepStatus;
  reason?: string;
  txs: TxRecord[];
  checks: CheckRecord[];
  facts: Record<string, string>;
  operatorCall?: OperatorCall;
  durationMs: number;
}

class Skipped extends Error {}
class NeedsOperator extends Error {
  constructor(readonly call: OperatorCall) {
    super("needs operator");
  }
}
export class CheckFailed extends Error {}

/** Wei amounts are bigints: the report keeps them as decimal strings (constitution 7). */
export const str = (value: unknown): string => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(str).join(", ")}]`;
  if (value === undefined) return "undefined";
  return typeof value === "string"
    ? value
    : JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A transaction that is not mined after this long is reported as a failure instead of waiting for ever. */
const TX_TIMEOUT_MS = 240_000;

export interface RunnerOptions {
  /** Pause after every confirmed transaction: public RPCs sit behind load balancers that lag a block. */
  settleMs: number;
  /** Extra attempts of a transaction that fails before it is mined (live chains only). */
  retries: number;
  log: (message: string) => void;
  /** Runs after every confirmed transaction (a live chain waits until the reading node has the block). */
  afterTx?: (receipt: TransactionReceipt) => Promise<void>;
  /** Called after every step with all results so far (the report is rewritten, a crash keeps what was done). */
  onStep?: (results: StepResult[]) => void;
}

/** What a step body sees: assertions, transaction sending and the skip / needs-operator exits. */
export class StepContext {
  readonly txs: TxRecord[] = [];
  readonly checks: CheckRecord[] = [];
  readonly facts: Record<string, string> = {};

  constructor(
    private readonly opts: RunnerOptions,
    readonly id: string,
  ) {}

  /** Records an assertion; a failed one ends the step (the next independent step still runs). */
  check(label: string, ok: boolean, expected?: unknown, actual?: unknown): void {
    this.checks.push({
      label,
      ok,
      ...(expected === undefined ? {} : { expected: str(expected) }),
      ...(actual === undefined ? {} : { actual: str(actual) }),
    });
    if (!ok) {
      throw new CheckFailed(
        `${label}${expected === undefined ? "" : `: expected ${str(expected)}, got ${str(actual)}`}`,
      );
    }
  }

  eq(label: string, actual: unknown, expected: unknown): void {
    this.check(label, str(actual).toLowerCase() === str(expected).toLowerCase(), expected, actual);
  }

  /** |actual - expected| <= tolerance, all bigint. */
  near(label: string, actual: bigint, expected: bigint, tolerance: bigint): void {
    const diff = actual > expected ? actual - expected : expected - actual;
    this.check(label, diff <= tolerance, `${expected} +- ${tolerance}`, actual);
  }

  fact(key: string, value: unknown): void {
    this.facts[key] = str(value);
  }

  skip(reason: string): never {
    throw new Skipped(reason);
  }

  needsOperator(call: OperatorCall): never {
    throw new NeedsOperator(call);
  }

  /** Sends one transaction, waits for it and asserts it succeeded; `send` is retried on transient node errors. */
  async tx(
    label: string,
    send: () => Promise<{
      wait(confirms?: number, timeout?: number): Promise<TransactionReceipt | null>;
      hash: string;
    }>,
  ): Promise<TransactionReceipt> {
    let attempt = 0;
    for (;;) {
      let response: Awaited<ReturnType<typeof send>>;
      try {
        response = await send();
      } catch (error) {
        // nothing was broadcast (node lag, nonce, estimation): safe to try again; a broadcast transaction never is
        if (error instanceof CheckFailed || attempt >= this.opts.retries) throw error;
        attempt += 1;
        this.opts.log(
          `    retry ${attempt}/${this.opts.retries} of ${label}: ${(error as Error).message.slice(0, 120)}`,
        );
        await sleep(Math.max(this.opts.settleMs, 2000) * 2);
        continue;
      }
      let receipt: TransactionReceipt | null;
      try {
        receipt = await response.wait(1, TX_TIMEOUT_MS);
      } catch (error) {
        // a mined revert spent gas and would revert again
        const mined = (error as { receipt?: TransactionReceipt }).receipt;
        if (mined) throw new CheckFailed(`${label}: transaction ${mined.hash} reverted`);
        throw error;
      }
      if (receipt === null) throw new Error(`${label}: no receipt for ${response.hash}`);
      this.txs.push({
        label,
        from: receipt.from,
        hash: receipt.hash,
        block: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        feeWei: (receipt.gasUsed * receipt.gasPrice).toString(),
      });
      await this.opts.afterTx?.(receipt);
      if (this.opts.settleMs > 0) await sleep(this.opts.settleMs);
      return receipt;
    }
  }

  /** The call must revert with the custom error `errorName` (checked through an eth_call, no gas spent). */
  async reverts(label: string, call: Promise<unknown>, abi: Contract | Interface, errorName: string): Promise<void> {
    const iface = "interface" in abi ? abi.interface : abi;
    let name = "";
    try {
      await call;
    } catch (error) {
      const e = error as { revert?: { name?: string }; data?: string; info?: { error?: { data?: string } } };
      name = e.revert?.name ?? "";
      if (name === "") {
        const data = e.data ?? e.info?.error?.data;
        if (typeof data === "string" && data.length >= 10) {
          name = iface.parseError(data)?.name ?? `selector ${data.slice(0, 10)}`;
        }
      }
      if (name === "") name = (error as Error).message.slice(0, 100);
      this.check(`${label} reverts ${errorName}`, name === errorName, errorName, name);
      return;
    }
    this.check(`${label} reverts ${errorName}`, false, errorName, "no revert");
  }
}

/** Runs the steps in order, records the outcome of each and blocks the steps whose dependencies failed. */
export class Runner {
  readonly results: StepResult[] = [];

  constructor(private readonly opts: RunnerOptions) {}

  statusOf(id: string): StepStatus | undefined {
    return this.results.find((r) => r.id === id)?.status;
  }

  async step(
    id: string,
    title: string,
    options: { needs?: string[] },
    body: (s: StepContext) => Promise<void>,
  ): Promise<StepStatus> {
    const started = Date.now();
    const s = new StepContext(this.opts, id);
    const result: StepResult = {
      id,
      title,
      status: "PASS",
      txs: s.txs,
      checks: s.checks,
      facts: s.facts,
      durationMs: 0,
    };
    const needs = options.needs ?? [];
    const blocked = needs.find((n) => ["FAIL", "BLOCKED", undefined].includes(this.statusOf(n)));
    const skipped = needs.find((n) => ["SKIPPED", "NEEDS-OPERATOR"].includes(this.statusOf(n) ?? ""));
    if (blocked !== undefined) {
      result.status = "BLOCKED";
      result.reason = `depends on ${blocked} (${this.statusOf(blocked) ?? "not run"})`;
    } else if (skipped !== undefined) {
      result.status = "SKIPPED";
      result.reason = `depends on ${skipped} (${this.statusOf(skipped)})`;
    } else {
      try {
        await body(s);
      } catch (error) {
        if (error instanceof Skipped) {
          result.status = "SKIPPED";
          result.reason = error.message;
        } else if (error instanceof NeedsOperator) {
          result.status = "NEEDS-OPERATOR";
          result.operatorCall = error.call;
          result.reason = `${error.call.contract}.${error.call.function} by ${error.call.from}`;
        } else {
          result.status = "FAIL";
          result.reason = (error as Error).message.slice(0, 600);
        }
      }
    }
    result.durationMs = Date.now() - started;
    this.results.push(result);
    this.opts.onStep?.(this.results);
    this.opts.log(`  ${result.status.padEnd(14)} ${id}${result.reason ? `  - ${result.reason.slice(0, 150)}` : ""}`);
    return result.status;
  }

  counts(): Record<StepStatus, number> {
    const out: Record<StepStatus, number> = { PASS: 0, FAIL: 0, SKIPPED: 0, "NEEDS-OPERATOR": 0, BLOCKED: 0 };
    for (const r of this.results) out[r.status] += 1;
    return out;
  }

  /** Short console table: id, status, transactions, gas, reason. */
  table(): string {
    const rows = this.results.map((r) => {
      const gas = r.txs.reduce((sum, t) => sum + BigInt(t.gasUsed), 0n);
      return [r.id, r.status, String(r.txs.length), gas.toString(), (r.reason ?? "").slice(0, 70)];
    });
    const head = ["step", "status", "txs", "gas", "note"];
    const width = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(width[i])).join("  ");
    return [line(head), line(width.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
  }
}
