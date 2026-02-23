/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  async redirects() {
    return [
      { source: "/", destination: "/openrefine", permanent: false },
      { source: "/app/editor", destination: "/openrefine", permanent: false }
    ];
  }
};

export default nextConfig;
