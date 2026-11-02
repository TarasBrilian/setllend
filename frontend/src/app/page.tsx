import { Wallet } from "@/components/wallet";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">Setllend</h1>
      <p>Fixed-rate lending and borrowing across Base and Arbitrum, settled on NEAR Intents.</p>
      <Wallet />
    </main>
  );
}
