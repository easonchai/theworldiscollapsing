import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  Bet as BetEvent,
  Claimed as ClaimedEvent,
  EventCreated as EventCreatedEvent,
  Resolved as ResolvedEvent,
} from "../generated/Arena/Arena";
import { Bet, Bettor, Claim, Event, Market, Position, Protocol } from "../generated/schema";

const PROTOCOL_ID = "1";

/** Market.id = eventId ++ outcomeIdx (1 byte). */
export function marketId(eventId: Bytes, outcomeIdx: i32): Bytes {
  const idx = new Uint8Array(1);
  idx[0] = outcomeIdx as u8;
  return eventId.concat(Bytes.fromUint8Array(idx));
}

/** Position.id = eventId ++ outcomeIdx ++ bettor. */
export function positionId(eventId: Bytes, outcomeIdx: i32, bettor: Address): Bytes {
  return marketId(eventId, outcomeIdx).concat(bettor);
}

/** Bet.id / Claim.id = txHash ++ logIndex. */
function logId(ev: ethereum.Event): Bytes {
  return ev.transaction.hash.concatI32(ev.logIndex.toI32());
}

function protocol(): Protocol {
  let p = Protocol.load(PROTOCOL_ID);
  if (p == null) {
    p = new Protocol(PROTOCOL_ID);
    p.eventCount = 0;
    p.betCount = 0;
    p.totalVolume = BigInt.zero();
    p.totalFees = BigInt.zero();
  }
  return p;
}

function bettor(addr: Address): Bettor {
  let b = Bettor.load(addr);
  if (b == null) {
    b = new Bettor(addr);
    b.betCount = 0;
    b.totalStaked = BigInt.zero();
    b.totalClaimed = BigInt.zero();
  }
  return b;
}

export function handleEventCreated(e: EventCreatedEvent): void {
  const ev = new Event(e.params.eventId);
  ev.nOutcomes = e.params.nOutcomes;
  ev.lockTime = e.params.lockTime;
  ev.drandRound = e.params.drandRound;
  ev.resolved = false;
  ev.createdAt = e.block.timestamp;
  ev.createdTx = e.transaction.hash;
  ev.totalPool = BigInt.zero();
  ev.betCount = 0;
  ev.save();

  // One market row per outcome index, up front, so an event with no bets still lists its markets.
  for (let i = 0; i < ev.nOutcomes; i++) {
    const m = new Market(marketId(ev.id, i));
    m.event = ev.id;
    m.outcomeIdx = i;
    m.yesPool = BigInt.zero();
    m.noPool = BigInt.zero();
    m.save();
  }

  const p = protocol();
  p.eventCount = p.eventCount + 1;
  p.save();
}

export function handleBet(e: BetEvent): void {
  const ev = Event.load(e.params.eventId);
  if (ev == null) return; // bet on an event created before startBlock
  const m = Market.load(marketId(e.params.eventId, e.params.outcomeIdx));
  if (m == null) return;

  if (e.params.yes) m.yesPool = m.yesPool.plus(e.params.amount);
  else m.noPool = m.noPool.plus(e.params.amount);
  m.save();

  ev.totalPool = ev.totalPool.plus(e.params.amount);
  ev.betCount = ev.betCount + 1;
  ev.save();

  const pid = positionId(e.params.eventId, e.params.outcomeIdx, e.params.bettor);
  let pos = Position.load(pid);
  if (pos == null) {
    pos = new Position(pid);
    pos.market = m.id;
    pos.event = ev.id;
    pos.bettor = e.params.bettor;
    pos.yesStake = BigInt.zero();
    pos.noStake = BigInt.zero();
    pos.claimed = false;
  }
  if (e.params.yes) pos.yesStake = pos.yesStake.plus(e.params.amount);
  else pos.noStake = pos.noStake.plus(e.params.amount);
  pos.save();

  const b = new Bet(logId(e));
  b.event = ev.id;
  b.market = m.id;
  b.bettor = e.params.bettor;
  b.yes = e.params.yes;
  b.amount = e.params.amount;
  b.timestamp = e.block.timestamp;
  b.tx = e.transaction.hash;
  b.save();

  const who = bettor(e.params.bettor);
  who.betCount = who.betCount + 1;
  who.totalStaked = who.totalStaked.plus(e.params.amount);
  who.save();

  const p = protocol();
  p.betCount = p.betCount + 1;
  p.totalVolume = p.totalVolume.plus(e.params.amount);
  p.save();
}

export function handleResolved(e: ResolvedEvent): void {
  const ev = Event.load(e.params.eventId);
  if (ev == null) return;
  ev.resolved = true;
  ev.outcome = e.params.outcome;
  ev.signature = e.params.signature;
  ev.save();
}

export function handleClaimed(e: ClaimedEvent): void {
  const ev = Event.load(e.params.eventId);
  if (ev == null) return;

  // Arena.claim settles every market of the event in one call, so every position of this
  // bettor on this event is spent — the event carries no per-market claim log.
  for (let i = 0; i < ev.nOutcomes; i++) {
    const pos = Position.load(positionId(ev.id, i, e.params.bettor));
    if (pos == null) continue;
    pos.claimed = true;
    pos.save();
  }

  const c = new Claim(logId(e));
  c.event = ev.id;
  c.bettor = e.params.bettor;
  c.payout = e.params.payout;
  c.fee = e.params.fee;
  c.timestamp = e.block.timestamp;
  c.tx = e.transaction.hash;
  c.save();

  const who = bettor(e.params.bettor);
  who.totalClaimed = who.totalClaimed.plus(e.params.payout);
  who.save();

  const p = protocol();
  p.totalFees = p.totalFees.plus(e.params.fee);
  p.save();
}
