export function SubgraphNotConfigured({ what }: { what: string }) {
  return (
    <div className="panel m-3 max-w-[70ch] border-amber/40 p-3">
      <p className="tag text-amber">subgraph not configured</p>
      <p className="mt-2 text-[14px] text-bone">
        {what} is read from the subgraph, not from our database, so this page stays empty until{" "}
        <code className="num text-amber">NEXT_PUBLIC_SUBGRAPH_URL</code> points at a deployed index of the Arena
        contract.
      </p>
      <p className="mt-2 font-mono text-[12px] text-dim">
        Nothing here is mocked: an empty index shows as empty.
      </p>
    </div>
  );
}
