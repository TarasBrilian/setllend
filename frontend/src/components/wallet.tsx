"use client";

import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";

export function Wallet() {
  const { address, status } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();

  if (status === "connected") {
    return (
      <div className="flex flex-col gap-2">
        {/* An EVM address is used as a NEAR implicit account in lowercase. */}
        <p className="font-mono text-sm">Intents account: {address.toLowerCase()}</p>
        <button className="rounded border px-3 py-1" onClick={() => disconnect.mutate()}>
          Disconnect
        </button>
      </div>
    );
  }

  if (connectors.length === 0) {
    // Also shown before the client has discovered wallets, so the text covers both cases.
    return <p>Looking for EVM wallets. If none appear, install MetaMask, Rabby, or another browser wallet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {connectors.map((connector) => (
        <button
          key={connector.uid}
          className="rounded border px-3 py-1"
          disabled={connect.isPending}
          onClick={() => connect.mutate({ connector })}
        >
          Connect {connector.name}
        </button>
      ))}
      {connect.error && <p className="text-sm text-red-600">{connect.error.message}</p>}
    </div>
  );
}
