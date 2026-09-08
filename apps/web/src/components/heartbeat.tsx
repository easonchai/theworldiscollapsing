"use client";

import { useEffect } from "react";

/** Presence: the engine only spends money on a new event while somebody has a page open. */
export function Heartbeat() {
  useEffect(() => {
    const beat = () => void fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
    beat();
    const id = setInterval(beat, 30_000);
    return () => clearInterval(id);
  }, []);
  return null;
}
