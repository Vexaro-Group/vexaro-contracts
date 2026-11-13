module.exports = {
  istanbulReporter: ["html", "lcov"],
  // NB: solidity-coverage@0.8.5 matches skipFiles by literal path prefix, not globs,
  // so the whole mocks folder is skipped (covers Mock*.sol, present and future).
  skipFiles: ["test", "mocks"],
};
