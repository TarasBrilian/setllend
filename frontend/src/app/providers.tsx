"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { AccountProvider } from "@/lib/account";
import { ApiModeProvider } from "@/lib/api-mode";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ApiModeProvider>
          <AccountProvider>{children}</AccountProvider>
        </ApiModeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
