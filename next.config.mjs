/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // We import .json with the `with { type: 'json' }` syntax in lib/pipeline/data.
    // No special config needed, but kept here as a marker if Next ever adds one.
  },
  webpack: (config) => {
    // Pipeline source uses NodeNext-style ".js" extensions on relative imports
    // that actually resolve to ".ts" files. Tell webpack to try .ts/.tsx first.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
