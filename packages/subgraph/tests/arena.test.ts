import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { assert, beforeAll, clearStore, describe, newMockEvent, test } from "matchstick-as/assembly/index";
import {
  Bet as BetEvent,
  Claimed as ClaimedEvent,
  EventCreated as EventCreatedEvent,
  Resolved as ResolvedEvent,
} from "../generated/Arena/Arena";
import { handleBet, handleClaimed, handleEventCreated, handleResolved, marketId, positionId } from "../src/mapping";

const EVENT_ID = Bytes.fromHexString("0x1111111111111111111111111111111111111111111111111111111111111111");
const ALICE = Address.fromString("0x00000000000000000000000000000000000000aa");
const BOB = Address.fromString("0x00000000000000000000000000000000000000bb");
const SIG = Bytes.fromHexString("0x" + "ab".repeat(48));

function param(name: string, value: ethereum.Value): ethereum.EventParam {
  return new ethereum.EventParam(name, value);
}

function created(nOutcomes: i32): EventCreatedEvent {
  const e = changetype<EventCreatedEvent>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(param("eventId", ethereum.Value.fromFixedBytes(EVENT_ID)));
  e.parameters.push(param("nOutcomes", ethereum.Value.fromI32(nOutcomes)));
  e.parameters.push(param("lockTime", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1700))));
  e.parameters.push(param("drandRound", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(42))));
  return e;
}

function bet(bettor: Address, outcomeIdx: i32, yes: boolean, amount: i32, logIndex: i32): BetEvent {
  const e = changetype<BetEvent>(newMockEvent());
  e.logIndex = BigInt.fromI32(logIndex);
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(param("eventId", ethereum.Value.fromFixedBytes(EVENT_ID)));
  e.parameters.push(param("bettor", ethereum.Value.fromAddress(bettor)));
  e.parameters.push(param("outcomeIdx", ethereum.Value.fromI32(outcomeIdx)));
  e.parameters.push(param("yes", ethereum.Value.fromBoolean(yes)));
  e.parameters.push(param("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(amount))));
  return e;
}

function resolved(outcome: i32): ResolvedEvent {
  const e = changetype<ResolvedEvent>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(param("eventId", ethereum.Value.fromFixedBytes(EVENT_ID)));
  e.parameters.push(param("outcome", ethereum.Value.fromI32(outcome)));
  e.parameters.push(param("signature", ethereum.Value.fromBytes(SIG)));
  return e;
}

function claimed(bettor: Address, payout: i32, fee: i32): ClaimedEvent {
  const e = changetype<ClaimedEvent>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(param("eventId", ethereum.Value.fromFixedBytes(EVENT_ID)));
  e.parameters.push(param("bettor", ethereum.Value.fromAddress(bettor)));
  e.parameters.push(param("payout", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(payout))));
  e.parameters.push(param("fee", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(fee))));
  return e;
}

const m0 = marketId(EVENT_ID, 0).toHexString();
const m1 = marketId(EVENT_ID, 1).toHexString();
const m2 = marketId(EVENT_ID, 2).toHexString();
const aliceP0 = positionId(EVENT_ID, 0, ALICE).toHexString();
const aliceP1 = positionId(EVENT_ID, 1, ALICE).toHexString();
const bobP0 = positionId(EVENT_ID, 0, BOB).toHexString();
const eid = EVENT_ID.toHexString();

describe("Arena mappings", () => {
  beforeAll(() => {
    clearStore();
    // The real chain order: create → bets → resolve → claim.
    handleEventCreated(created(3));
    handleBet(bet(ALICE, 0, true, 30, 1));
    handleBet(bet(BOB, 0, false, 20, 2));
    handleBet(bet(ALICE, 1, true, 10, 3));
    handleResolved(resolved(0));
    handleClaimed(claimed(ALICE, 49, 1));
  });

  test("EventCreated stores the event and one market per outcome", () => {
    assert.entityCount("Event", 1);
    assert.entityCount("Market", 3);
    assert.fieldEquals("Event", eid, "nOutcomes", "3");
    assert.fieldEquals("Event", eid, "lockTime", "1700");
    assert.fieldEquals("Event", eid, "drandRound", "42");
    assert.fieldEquals("Market", m2, "outcomeIdx", "2");
    assert.fieldEquals("Market", m2, "yesPool", "0");
    assert.fieldEquals("Market", m2, "noPool", "0");
  });

  test("Bet accumulates pools, positions and event totals", () => {
    assert.fieldEquals("Market", m0, "yesPool", "30");
    assert.fieldEquals("Market", m0, "noPool", "20");
    assert.fieldEquals("Market", m1, "yesPool", "10");
    assert.fieldEquals("Market", m1, "noPool", "0");
    assert.fieldEquals("Event", eid, "totalPool", "60");
    assert.fieldEquals("Event", eid, "betCount", "3");
    assert.entityCount("Bet", 3);
    assert.fieldEquals("Position", aliceP0, "yesStake", "30");
    assert.fieldEquals("Position", aliceP0, "noStake", "0");
    assert.fieldEquals("Position", bobP0, "noStake", "20");
  });

  test("Resolved records outcome and signature", () => {
    assert.fieldEquals("Event", eid, "resolved", "true");
    assert.fieldEquals("Event", eid, "outcome", "0");
    assert.fieldEquals("Event", eid, "signature", SIG.toHexString());
  });

  test("Claimed flips every position the bettor holds on that event", () => {
    assert.fieldEquals("Position", aliceP0, "claimed", "true");
    assert.fieldEquals("Position", aliceP1, "claimed", "true");
    assert.fieldEquals("Position", bobP0, "claimed", "false");
    assert.entityCount("Claim", 1);
  });

  test("Bettor and Protocol aggregates", () => {
    assert.fieldEquals("Bettor", ALICE.toHexString(), "betCount", "2");
    assert.fieldEquals("Bettor", ALICE.toHexString(), "totalStaked", "40");
    assert.fieldEquals("Bettor", ALICE.toHexString(), "totalClaimed", "49");
    assert.fieldEquals("Bettor", BOB.toHexString(), "betCount", "1");
    assert.fieldEquals("Bettor", BOB.toHexString(), "totalClaimed", "0");
    assert.fieldEquals("Protocol", "1", "eventCount", "1");
    assert.fieldEquals("Protocol", "1", "betCount", "3");
    assert.fieldEquals("Protocol", "1", "totalVolume", "60");
    assert.fieldEquals("Protocol", "1", "totalFees", "1");
  });
});
