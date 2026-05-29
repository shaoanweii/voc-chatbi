/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  devIndicators: false,
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: {
    '*': ['node_modules/.cache/**/*'],
  },
};

export default nextConfig;
