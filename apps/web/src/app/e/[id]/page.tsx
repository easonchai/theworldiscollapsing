import { notFound } from "next/navigation";
import { getEvent } from "@/lib/data";
import { EventStage } from "@/components/event-stage";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: PageProps<"/e/[id]">) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  return <EventStage key={event.id} initial={event} />;
}
