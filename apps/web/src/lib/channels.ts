/**
 * Station identity per channel (PRD story 21): a channel number and one accent, spent on the
 * channel number and nowhere else — and only on the wall, where four channels sit side by side and
 * a viewer has to tell them apart at a glance. Numbers, not shapes — a triangle beside SPORTS is a
 * button, not a mark. No signal tint: hue-rotating the picture made four copies of one feed instead
 * of four channels, and it spent the saturation budget the tally and the clock need.
 * This map is the only place a channel's look is decided.
 */
const IDENT: Record<string, { accent: string; num: string }> = {
  sports: { accent: "#c8e05a", num: "01" },
  politics: { accent: "#48b0ff", num: "02" },
  culture: { accent: "#e06bd8", num: "03" },
  region: { accent: "#8f8fff", num: "04" },
};

/** Anything the engine adds later still gets furniture, just the house bone-white one. */
const FALLBACK = { accent: "#ece7da", num: "00" };

export const identOf = (channelId: string) => IDENT[channelId] ?? FALLBACK;

export const channelIdents = IDENT;
