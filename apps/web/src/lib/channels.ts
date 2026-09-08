/**
 * Station identity per channel: one accent colour and one ident glyph each, so the four tiles on
 * the wall read as four channels rather than one channel shown four times (PRD story 21).
 * This map is the only place a channel's look is decided.
 */
const IDENT: Record<string, { accent: string; glyph: string }> = {
  sports: { accent: "#64e39b", glyph: "▲" },
  politics: { accent: "#f2a93b", glyph: "■" },
  culture: { accent: "#c07bff", glyph: "●" },
  region: { accent: "#4fb8ff", glyph: "◆" },
};

/** Anything the engine adds later still gets furniture, just the house bone-white one. */
const FALLBACK = { accent: "#ece7da", glyph: "◇" };

export const identOf = (channelId: string) => IDENT[channelId] ?? FALLBACK;

export const channelIdents = IDENT;
