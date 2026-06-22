"use client";

import { SessionProvider } from "next-auth/react";
import { RnBridge } from "./RnBridge";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <RnBridge />
      {children}
    </SessionProvider>
  );
}
