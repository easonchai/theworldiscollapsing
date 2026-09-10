import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { identOf } from "@/lib/channels";
import { getChannels, getEvents } from "@/lib/data";
import { ChannelStage } from "@/components/channel-stage";
import { StateBadge } from "@/components/bits";

export const dynamic = "force-dynamic";

export default async function ChannelPage({ params }: PageProps<"/c/[channel]">) {
  const { channel } = await params;
  const [channels, recent] = await Promise.all([getChannels(), getEvents({ channel, limit: 12 })]);
  const info = channels.find((c) => c.id === channel);
  if (!info) notFound();
  const current = info.current;
  const history = recent.filter((e) => e.id !== current?.id);
  const ident = identOf(info.id);

  return (
    <div>
      {/* The channel is a label, not the subject of the page: one 46px bar on the same baseline as
          the station bar, carrying number, name and what is on it. The event's own clock below is
          the thing a viewer came for, so nothing up here is allowed to out-size it. */}
      <header className="flex h-[46px] items-center gap-2 border-b border-line px-2">
        <span className="num text-[10px] leading-none text-[color:var(--ch)]" style={{ "--ch": ident.accent } as CSSProperties}>
          CH {ident.num}
        </span>
        <h1 className="display text-[15px] leading-none tracking-[0.16em] text-bone">{info.name}</h1>
        {current ? (
          <>
            <span className="h-3 w-px bg-line" aria-hidden />
            <span className="data min-w-0 truncate text-dim">{current.title}</span>
          </>
        ) : null}
      </header>

      {current ? (
        <ChannelStage current={current} />
      ) : (
        <p className="copy px-2 py-4 text-dim">This channel has not gone on air yet.</p>
      )}

      <div className="grid gap-px border-t border-line bg-line lg:grid-cols-3">
        <section className="min-w-0 bg-vac px-2 py-2">
          <h2 className="text-[20px] text-bone">Canon</h2>
          <p className="copy mt-1 text-dim">What the world now believes.</p>
          <ol className="mt-2 space-y-2">
            {info.canon.length ? (
              info.canon.map((line, i) => (
                <li key={i} className="copy border-l-2 border-line pl-2 text-bone">
                  {line}
                </li>
              ))
            ) : (
              <li className="tag">nothing has happened here yet</li>
            )}
          </ol>
        </section>

        <section className="min-w-0 bg-vac px-2 py-2">
          <h2 className="text-[20px] text-bone">Newsroom</h2>
          <p className="copy mt-1 text-dim">How this event was thought up.</p>
          <details className="mt-2 panel p-2">
            <summary className="tag cursor-pointer text-bone">Reasoning trace</summary>
            <p className="copy mt-2 max-h-64 overflow-y-auto break-words whitespace-pre-wrap text-dim">
              {current?.reasoning ?? "No trace recorded for this event."}
            </p>
          </details>
        </section>

        <section className="min-w-0 bg-vac px-2 py-2">
          <h2 className="text-[20px] text-bone">Recent events</h2>
          <p className="copy mt-1 text-dim">This channel&rsquo;s history.</p>
          <ul className="mt-2 divide-y divide-line">
            {history.length ? (
              history.map((e) => (
                <li key={e.id}>
                  <Link href={`/e/${e.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-panel2">
                    <span className="min-w-0">
                      <span className="data block truncate text-bone">{e.title}</span>
                      <span className="tag mt-1 block">
                        #{String(e.seq).padStart(3, "0")}
                        {e.outcome !== null ? ` · ${e.outcomes[e.outcome]}` : " · undecided"}
                      </span>
                    </span>
                    <StateBadge state={e.state} />
                  </Link>
                </li>
              ))
            ) : (
              <li className="data py-2 text-dim">No archive yet.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
