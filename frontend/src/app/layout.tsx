import type { ReactNode } from "react";
import Script from "next/script";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body style={{ fontFamily: "sans-serif", margin: 0 }}>
        <Script src="https://auth.dataviz.jp/lib/supabase.js" strategy="beforeInteractive" />
        <Script src="https://auth.dataviz.jp/lib/dataviz-auth-client.js" strategy="afterInteractive" />
        {children}
      </body>
    </html>
  );
}
