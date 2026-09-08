"use client";

import { useEffect, useRef } from "react";
import type { EventPublic } from "@/lib/public";
import { REVEALED } from "@/lib/public";

/** Everyone is watching the same moment: playback position is derived from the on-chain clock. */
export function sourceFor(event: EventPublic): { src: string | null; t0: number | null; revealed: boolean } {
  const revealed = REVEALED.has(event.state) && !!event.winningBranchUrl;
  if (revealed) return { src: event.winningBranchUrl, t0: Date.parse(event.revealTime ?? ""), revealed: true };
  return { src: event.firstHalfUrl, t0: event.startTime ? Date.parse(event.startTime) : null, revealed: false };
}

export function Player({
  event,
  className = "",
  poster,
}: {
  event: EventPublic;
  className?: string;
  poster?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const { src, t0 } = sourceFor(event);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src || !t0) return;

    // Seek to where the broadcast is now. Past the end, hold the last frame: never loop, never restart.
    const sync = (force: boolean) => {
      if (!video.duration || Number.isNaN(video.duration)) return;
      const elapsed = (Date.now() - t0) / 1000;
      if (elapsed >= video.duration) {
        video.pause();
        if (video.currentTime < video.duration - 0.06) video.currentTime = video.duration - 0.05;
        return;
      }
      if (force || Math.abs(video.currentTime - elapsed) > 0.75) video.currentTime = Math.max(0, elapsed);
      void video.play().catch(() => {});
    };

    const onMeta = () => sync(true);
    video.addEventListener("loadedmetadata", onMeta);
    if (video.readyState >= 1) sync(true);
    const id = setInterval(() => sync(false), 3000);
    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      clearInterval(id);
    };
  }, [src, t0]);

  if (!src) {
    return (
      <div className={`grid place-items-center bg-black ${className}`}>
        <p className="tag animate-pulse">no signal — rendering</p>
      </div>
    );
  }

  return (
    <video
      ref={ref}
      key={src}
      src={src}
      poster={poster}
      className={`bg-black object-cover ${className}`}
      muted
      playsInline
      autoPlay
      preload="auto"
      disablePictureInPicture
    />
  );
}
