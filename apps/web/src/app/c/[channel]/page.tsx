import Link from "next/link";
import { notFound } from "next/navigation";
import { getChannels, getEvents } from "@/lib/data";
import { EventStage } from "@/components/event-stage";
import { StateBadge } from "@/components/bits";

export const dynamic = "force-dynamic";

export default async function ChannelPage({ params }: PageProps<"/c/[channel]">) {
  const { channel } = await params;
  const [channels, recent] = await Promise.all([getChannels(), getEvents({ channel, limit: 12 })]);
  const info = channels.find((c) => c.id === channel);
  if (!info) notFound();
  const current = info.current;
  const history = recent.filter((e) => e.id !== current?.id);

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-2 border-b border-line px-3 py-3">
        <div>
          <p className="tag">channel</p>
          <h1 className="mt-1 text-[clamp(34px,5vw,66px)] leading-none text-bone">{info.name}</h1>
        </div>
        {current ? (
          <div className="text-right">
            <p className="tag">now on air</p>
            <p className="mt-1 max-w-[46ch] font-body text-[17px] text-dim italic">{current.title}</p>
          </div>
        ) : null}
      </header>

      {current ? (
        <EventStage key={current.id} initial={current} showHeader={false} />
      ) : (
        <p className="px-3 py-6 font-mono text-sm text-dim">This channel has not gone on air yet.</p>
      )}

      <div className="grid gap-px border-t border-line bg-line lg:grid-cols-3">
        <section className="min-w-0 bg-vac p-3">
          <h2 className="text-[20px] text-bone">Canon</h2>
          <p className="tag mt-1">what the world now believes</p>
          <ol className="mt-2 space-y-2">
            {info.canon.length ? (
              info.canon.map((line, i) => (
                <li key={i} className="border-l-2 border-amber/60 pl-2 font-body text-[16px] text-bone">
                  {line}
                </li>
              ))
            ) : (
              <li className="font-mono text-[12px] text-dim">Nothing has happened here yet.</li>
            )}
          </ol>
        </section>

        <section className="min-w-0 bg-vac p-3">
          <h2 className="text-[20px] text-bone">Newsroom</h2>
          <p className="tag mt-1">how this event was thought up</p>
          <details className="mt-2 panel p-2">
            <summary className="cursor-pointer font-mono text-[11px] tracking-[0.14em] text-amber uppercase">
              Reasoning trace
            </summary>
            <p className="mt-2 max-h-64 overflow-y-auto font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-dim">
              {current?.reasoning ?? "No trace recorded for this event."}
            </p>
          </details>
        </section>

        <section className="min-w-0 bg-vac p-3">
          <h2 className="text-[20px] text-bone">Recent events</h2>
          <p className="tag mt-1">this channel&rsquo;s history</p>
          <ul className="mt-2 divide-y divide-line">
            {history.length ? (
              history.map((e) => (
                <li key={e.id}>
                  <Link href={`/e/${e.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-panel2">
                    <span className="min-w-0">
                      <span className="block truncate font-body text-[16px] text-bone">{e.title}</span>
                      <span className="num text-[11px] text-dim">
                        #{String(e.seq).padStart(3, "0")}
                        {e.outcome !== null ? ` · ${e.outcomes[e.outcome]}` : " · undecided"}
                      </span>
                    </span>
                    <StateBadge state={e.state} />
                  </Link>
                </li>
              ))
            ) : (
              <li className="py-2 font-mono text-[12px] text-dim">No archive yet.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
