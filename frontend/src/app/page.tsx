import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ padding: 24 }}>
      <h1>OpenRefine Web</h1>
      <p>Authentication is required before accessing the editor.</p>
      <Link href="/app/editor">Go to Editor</Link>
    </main>
  );
}
