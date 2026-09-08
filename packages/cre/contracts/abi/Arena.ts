// The slice of packages/contracts/abi/Arena.ts this workflow needs. TypeScript CRE workflows use
// viem ABIs directly (no `cre generate-bindings`), and the workflow is built with bun outside the
// pnpm workspace, so it cannot import the `contracts` package. Keep in sync by hand — these two
// members have not changed since day 1 and the workflow test pins the event signature.
export const arenaAbi = [
  {
    type: "event",
    name: "Resolved",
    inputs: [
      { name: "eventId", type: "bytes32", indexed: true },
      { name: "outcome", type: "uint8", indexed: false },
      { name: "signature", type: "bytes", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "events",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "nOutcomes", type: "uint8" },
      { name: "lockTime", type: "uint64" },
      { name: "drandRound", type: "uint64" },
      { name: "resolved", type: "bool" },
      { name: "outcome", type: "uint8" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;
