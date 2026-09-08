import { describe, expect, it } from "vitest";
import type { EventPublic } from "./public";
import type { SubgraphEventMarkets } from "./subgraph";
import { EVENT_WINDOW, MARKETS_QUERY, TITLE_WINDOW, marketRows } from "./market-rows";

const indexed = (id: string, createdAt: number, pools: [string, string][], resolved = false): SubgraphEventMarkets => ({
  id,
  nOutcomes: pools.length,
  lockTime: "0",
  drandRound: "1",
  resolved,
  outcome: resolved ? 0 : null,
  createdAt: String(createdAt),
  totalPool: "0",
  betCount: 0,
  markets: pools.map(([yesPool, noPool], outcomeIdx) => ({ id: `${id}0${outcomeIdx}`, outcomeIdx, yesPool, noPool })),
});

const title = (id: string, channelId: string): EventPublic =>
  ({ id, channelId, title: `${channelId} event`, state: "BETTING", outcomes: ["Yes side", "No side"] }) as EventPublic;

describe("MARKETS_QUERY", () => {
  it("asks for the newest events, not an unordered page of markets", () => {
    expect(MARKETS_QUERY).toContain(`events(first: ${EVENT_WINDOW}, orderBy: createdAt, orderDirection: desc)`);
    expect(MARKETS_QUERY).not.toMatch(/markets\(/);
    // Postgres must be able to name every event the index returns.
    expect(TITLE_WINDOW).toBeGreaterThan(EVENT_WINDOW);
  });
});

describe("marketRows", () => {
  it("drops events Postgres cannot name instead of listing them without a title or link", () => {
    const rows = marketRows(
      [indexed("0xaa", 2, [["1", "0"]]), indexed("0xbb", 1, [["1", "0"]])],
      { "0xaa": title("0xaa", "sports") },
      { channel: "all", state: "all" },
    );
    expect(rows.map((r) => r.indexed.id)).toEqual(["0xaa"]);
    expect(rows[0].event.title).toBe("sports event");
  });

  it("matches titles regardless of id case", () => {
    const rows = marketRows([indexed("0xAABB", 1, [["1", "0"]])], { "0xaabb": title("0xaabb", "sports") }, {
      channel: "all",
      state: "all",
    });
    expect(rows).toHaveLength(1);
  });

  it("lists every market of the window, biggest volume first", () => {
    const rows = marketRows(
      [indexed("0xaa", 2, [["1", "1"], ["10", "0"]]), indexed("0xbb", 1, [["5", "0"]])],
      { "0xaa": title("0xaa", "sports"), "0xbb": title("0xbb", "politics") },
      { channel: "all", state: "all" },
    );
    expect(rows.map((r) => r.volume)).toEqual([10n, 5n, 2n]);
  });

  it("filters by channel and by resolution", () => {
    const all: SubgraphEventMarkets[] = [
      indexed("0xaa", 2, [["1", "0"]]),
      indexed("0xbb", 1, [["1", "0"]], true),
    ];
    const titles = { "0xaa": title("0xaa", "sports"), "0xbb": title("0xbb", "politics") };
    expect(marketRows(all, titles, { channel: "sports", state: "all" }).map((r) => r.indexed.id)).toEqual(["0xaa"]);
    expect(marketRows(all, titles, { channel: "all", state: "open" }).map((r) => r.indexed.id)).toEqual(["0xaa"]);
    expect(marketRows(all, titles, { channel: "all", state: "resolved" }).map((r) => r.indexed.id)).toEqual(["0xbb"]);
  });
});
