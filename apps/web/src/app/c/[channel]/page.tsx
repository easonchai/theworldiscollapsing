import Link from "next/link";
import { notFound } from "next/navigation";
import { identOf } from "@/lib/channels";
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
  const ident = identOf(info.id);

  return (
    <div>
      {/* One lockup on the station's one left edge: the channel number over its name, nothing
          floating between them. The event's own title is on the monitor below, so it is not
          repeated here. */}
      <header className="border-b border-line px-2 py-2">
        <p className="tag">ch {ident.num}</p>
        <h1 className="mt-1 text-[clamp(34px,5vw,66px)] leading-[0.9] text-bone">{info.name}</h1>
      </header>

      {current ? (
        <EventStage key={current.id} initial={current} showHeader={false} />
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
            <summary className="cursor-pointer text-[12px] tracking-[0.14em] text-bone uppercase">
              Reasoning trace
            </summary>
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
                      <span className="block truncate text-[13px] text-bone">{e.title}</span>
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
              <li className="py-2 text-[12px] text-dim">No archive yet.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
