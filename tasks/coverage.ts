import { readFileSync } from "fs";
import { task, types } from "hardhat/config";

type Istanbul = {
  statementMap: Record<string, { start: { line: number } }>;
  s: Record<string, number>;
  b: Record<string, number[]>;
};

/** Lines = distinct start lines of statements (as in the lcov report); branches = every arm of every branch. */
export function summarize(file: Istanbul) {
  const lines = new Map<number, boolean>();
  for (const [id, loc] of Object.entries(file.statementMap)) {
    lines.set(loc.start.line, (lines.get(loc.start.line) ?? false) || file.s[id] > 0);
  }
  const arms = Object.values(file.b).flat();
  return {
    lines: { covered: [...lines.values()].filter(Boolean).length, total: lines.size },
    branches: { covered: arms.filter((n) => n > 0).length, total: arms.length },
  };
}

task("task:checkCoverage", "Fails when a contract is below the line / branch coverage threshold (run after `coverage`)")
  .addOptionalParam("min", "minimum percentage of lines and of branches per contract", "95", types.string)
  .addOptionalParam("file", "istanbul report written by `hardhat coverage`", "coverage.json", types.string)
  .setAction(async function (taskArguments) {
    const min = Number(taskArguments.min);
    const report: Record<string, Istanbul> = JSON.parse(readFileSync(taskArguments.file, "utf8"));
    const pct = (x: { covered: number; total: number }) => (x.total === 0 ? 100 : (100 * x.covered) / x.total);

    const failures: string[] = [];
    for (const [path, data] of Object.entries(report)) {
      const name = path.split("/contracts/").pop()!;
      const { lines, branches } = summarize(data);
      if (lines.total === 0 && branches.total === 0) continue; // interfaces
      console.log(
        `${name.padEnd(34)} lines ${pct(lines).toFixed(1).padStart(5)} % (${lines.covered}/${lines.total})  ` +
          `branches ${pct(branches).toFixed(1).padStart(5)} % (${branches.covered}/${branches.total})`,
      );
      if (pct(lines) < min) failures.push(`${name}: lines ${pct(lines).toFixed(1)} % < ${min} %`);
      if (pct(branches) < min) failures.push(`${name}: branches ${pct(branches).toFixed(1)} % < ${min} %`);
    }
    if (failures.length > 0) throw new Error(`Coverage below ${min} %:\n  ${failures.join("\n  ")}`);
  });
