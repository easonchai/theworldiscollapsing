/**
 * Station identity per channel (PRD story 21): a channel number, one accent used only for hairline
 * rules, and the hue its signal is tinted to, so four tiles carrying the same footage still read as
 * four different channels. Numbers, not shapes — a triangle beside SPORTS is a button, not a mark.
 * The accents deliberately avoid the semantic hues (live, urgency, fault, yes, no).
 * This map is the only place a channel's look is decided.
 */
const IDENT: Record<string, { accent: string; num: string; hue: number }> = {
  sports: { accent: "#c8e05a", num: "01", hue: 0 },
  politics: { accent: "#48b0ff", num: "02", hue: 70 },
  culture: { accent: "#e06bd8", num: "03", hue: 150 },
  region: { accent: "#8f8fff", num: "04", hue: 230 },
};

/** Anything the engine adds later still gets furniture, just the house bone-white one. */
const FALLBACK = { accent: "#ece7da", num: "00", hue: 300 };

export const identOf = (channelId: string) => IDENT[channelId] ?? FALLBACK;

export const channelIdents = IDENT;
