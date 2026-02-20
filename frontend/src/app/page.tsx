// This route is handled by the beforeFiles rewrite in next.config.mjs:
//   { source: "/", destination: "/openrefine/" }
// This file exists only as a fallback and should not be reached in normal operation.
export default function HomePage() {
  return null;
}
