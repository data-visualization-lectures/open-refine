/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/openrefine" },
        { source: "/app/editor", destination: "/openrefine" }
      ]
    };
  }
};

export default nextConfig;
