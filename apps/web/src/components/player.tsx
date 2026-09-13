"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import type { EventPublic } from "@/lib/public";
import { sourceFor } from "@/lib/playback";

/**
 * The station's no-signal card. A monitor with nothing on it is not a dimmed picture and not an
 * empty box: it is bars with no vertical lock and a plate that says so. Hard-edged, in the
 * station's own tones, so it reads as this station's failure state rather than as stock furniture.
 */
export function Standby({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div className={`relative overflow-hidden bg-black ${className}`}>
      <span className="standby" aria-hidden />
      <span className="roll" aria-hidden />
      <span className="scan" aria-hidden />
      <div className="absolute inset-0 z-10 grid place-items-center">
        <span className="slate tag px-2 py-1 text-bone">{label}</span>
      </div>
    </div>
  );
}

export function Player({
  event,
  className = "",
  poster,
  style,
}: {
  event: EventPublic;
  className?: string;
  poster?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const { src, t0, archive, loop } = sourceFor(event);

  useEffect(() => {
    const video = ref.current;
    // Archive has no chain clock to follow: it just plays (and loops) from the top.
    if (!video || !src || !t0) return;

    // Seek to where the broadcast is now. Past the end, hold the last frame (the first half ends
    // at the lock) or, for a revealed branch, wrap: `elapsed mod duration` keeps every viewer on
    // the same frame of the loop.
    const sync = (force: boolean) => {
      if (!video.duration || Number.isNaN(video.duration)) return;
      const elapsed = (Date.now() - t0) / 1000;
      if (elapsed >= video.duration && !loop) {
        video.pause();
        if (video.currentTime < video.duration - 0.06) video.currentTime = video.duration - 0.05;
        return;
      }
      const at = loop ? elapsed % video.duration : elapsed;
      if (force || Math.abs(video.currentTime - at) > 0.75) video.currentTime = Math.max(0, at);
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
  }, [src, t0, loop]);

  // A source that has not been cut to air yet gets the station's designed no-signal card, not a
  // decorated void.
  if (!src) return <Standby label="please stand by · rendering" className={className} />;

  return (
    <video
      ref={ref}
      key={src}
      src={src}
      poster={poster}
      style={style}
      className={`picture bg-black object-cover ${className}`}
      muted
      playsInline
      autoPlay
      loop={archive || loop}
      preload="auto"
      disablePictureInPicture
    />
  );
}
