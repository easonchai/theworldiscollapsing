import { SUBGRAPH_URL } from "./chain";

export const subgraphConfigured = !!SUBGRAPH_URL;

/** Entities as defined in packages/subgraph/schema.graphql (docs/CONTRACTS.md). */
export type SubgraphEvent = {
  id: string;
  nOutcomes: number;
  lockTime: string;
  drandRound: string;
  resolved: boolean;
  outcome: number | null;
  createdAt: string;
  totalPool: string;
  betCount: number;
};

export type SubgraphMarket = {
  id: string;
  outcomeIdx: number;
  yesPool: string;
  noPool: string;
  event: SubgraphEvent;
};

export type SubgraphPosition = {
  id: string;
  bettor: string;
  yesStake: string;
  noStake: string;
  claimed: boolean;
  market: { outcomeIdx: number };
  event: SubgraphEvent;
};

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0].message);
  if (!body.data) throw new Error("subgraph returned no data");
  return body.data;
}
