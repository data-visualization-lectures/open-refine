import type { ReactNode } from "react";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: "100vh", background: "#f6f7f9" }}>{children}</div>;
}
