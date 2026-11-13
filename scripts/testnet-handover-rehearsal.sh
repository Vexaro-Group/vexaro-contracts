#!/usr/bin/env bash
# Rehearsal of the mainnet safe-mode hand-over on BSC testnet (docs/deploy.md section 8.5).
#
#   scripts/testnet-handover-rehearsal.sh        read-only: the dry-run of the deployment, sends nothing
#   scripts/testnet-handover-rehearsal.sh run    REAL: deploys a fresh full set on BSC testnet, hands it over, renounces
#
# A fresh set goes into its own record and its own OpenZeppelin manifest, never into deployments/bscTestnet.json or
# .openzeppelin/bsc-testnet.json:
#   deployments/archive/oc18/bscTestnet.json (+ abis/), deployments/archive/oc18/openzeppelin/bsc-testnet.json
# The deployer is the throwaway testnet key (hardhat var TESTNET_DEPLOYER_KEY, never printed); the multisig stand-in is
# the testnet admin wallet 0x2dE355670DF16bc7475987F2Fa2a791547421f41 (an EOA, so no Safe owners / threshold to read).
# Every step is idempotent: after an interruption run the same command again.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-dry-run}"
HH="${HH:-npx hardhat}"
NET=bscTestnet
DIR=deployments/archive/oc18
PARAMS=deploy/params/bscTestnetRehearsal.ts
DEPLOYER=0x1E83eE3359E37Ef9230831fe2Dbe9b3529eF292d
export MANIFEST_DEFAULT_DIR="$DIR/openzeppelin"
# the default testnet node refuses eth_getLogs ("limit exceeded"); the --holders scan needs one that serves it
export HARDHAT_VAR_BSC_TESTNET_RPC_URL="${HARDHAT_VAR_BSC_TESTNET_RPC_URL:-https://bsc-testnet-rpc.publicnode.com}"
COMMON=(--network "$NET" --params-file "$PARAMS" --deployments-dir "$DIR")

step() {
  echo
  echo "=== $1"
  shift
  echo "\$ $HH $*"
  $HH "$@"
}

case "$MODE" in
  dry-run)
    echo "Read-only: nothing is sent. The later steps need the record this deployment writes."
    step "1/8 deployment, dry-run (every step as would / skip)" task:deploy:all "${COMMON[@]}" --dry-run --deployer "$DEPLOYER"
    cat <<EOF

The real run ('$0 run') then does:
  2/8 task:deploy:check                              0 DRIFT, phase setup
  3/8 task:deploy:handover --dry-run                 every grant / renounce / the kept DEFAULT_ADMIN
  4/8 task:deploy:handover                           grants to the multisig, renounces all but DEFAULT_ADMIN
  5/8 task:deploy:check --holders                    only the expected holders
  6/8 task:deploy:handover --renounce-admin --dry-run
  7/8 task:deploy:handover --renounce-admin          the deployer leaves every role it holds
  8/8 task:deploy:check --holders                    the multisig is the only admin, the deployer holds nothing
EOF
    ;;
  run)
    if ! $HH vars has TESTNET_DEPLOYER_KEY >/dev/null 2>&1 && [ -z "${HARDHAT_VAR_TESTNET_DEPLOYER_KEY:-}" ]; then
      echo "TESTNET_DEPLOYER_KEY is not set (hardhat var or HARDHAT_VAR_TESTNET_DEPLOYER_KEY): the throwaway deployer key" >&2
      exit 1
    fi
    step "1/8 deploy the fresh set" task:deploy:all "${COMMON[@]}" --no-verify
    step "2/8 check before the hand-over" task:deploy:check "${COMMON[@]}"
    step "3/8 hand-over dry-run" task:deploy:handover "${COMMON[@]}" --dry-run
    step "4/8 hand-over to the multisig (safe mode)" task:deploy:handover "${COMMON[@]}"
    step "5/8 check, with the holders scan" task:deploy:check "${COMMON[@]}" --holders --log-chunk 20000
    step "6/8 renounce-admin dry-run" task:deploy:handover "${COMMON[@]}" --renounce-admin --dry-run
    step "7/8 the deployer leaves every role" task:deploy:handover "${COMMON[@]}" --renounce-admin --log-chunk 20000
    step "8/8 final check, with the holders scan" task:deploy:check "${COMMON[@]}" --holders --log-chunk 20000
    echo
    echo "Rehearsal done. Record: $DIR/$NET.json; commit it with $DIR/abis and $DIR/openzeppelin."
    ;;
  *)
    echo "usage: $0 [dry-run|run]" >&2
    exit 2
    ;;
esac
