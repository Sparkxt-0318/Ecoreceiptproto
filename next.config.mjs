/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // We import .json with the `with { type: 'json' }` syntax in lib/pipeline/data.
    // No special config needed, but kept here as a marker if Next ever adds one.
  },
};

export default nextConfig;
