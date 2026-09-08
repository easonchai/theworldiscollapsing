import { getChannels } from "@/lib/data";
import { Wall } from "@/components/wall";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <Wall initial={await getChannels()} />;
}
