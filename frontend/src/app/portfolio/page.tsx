export default function PortfolioPage() {
  return <ComingNext title="Portfolio" />;
}

function ComingNext({ title }: { title: string }) {
  return (
    <section className="rounded-3xl border border-line bg-surface/60 px-12 py-16 text-center">
      <h1 className="text-3xl font-semibold">{title}</h1>
      <p className="mt-2 text-muted">Loans, notes, open orders, balances, and history. Coming next.</p>
    </section>
  );
}
