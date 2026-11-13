import type { DeployParams } from "../../tasks/deploy/types";
import bscTestnet from "./bscTestnet";

// Rehearsal on BSC testnet: a FRESH full set (TestUSDT included) deployed by the throwaway deployer key into its
// own record (scripts/testnet-handover-rehearsal.sh: deployments/archive/oc18/bscTestnet.json, its own OpenZeppelin
// manifest), never into deployments/bscTestnet.json. Everything is the testnet's, except what the mainnet hand-over
// does differently: the roles go straight to the multisig (an EOA stand-in here, the Safe on
// mainnet), no timelock, the deployer keeps DEFAULT_ADMIN until `--renounce-admin`, and the guardian is a different
// address from the deployer (as on mainnet), so that "the hand-over leaves GUARDIAN alone" is exercised for real.
const params: DeployParams = {
  ...bscTestnet,
  handoverMode: "safe",
  // the mainnet guardian address: a role holder only, no key is involved
  guardian: "0xa70A19F9563DBEf414D7143D5269Cc08269394a8",
};

export default params;
