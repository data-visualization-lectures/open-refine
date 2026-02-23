// This route is handled by redirects in next.config.mjs:
//   { source: "/", destination: "/openrefine/", permanent: false }
// This file exists only as a fallback and should not be reached in normal operation.
export default function HomePage() {
  return null;
}
