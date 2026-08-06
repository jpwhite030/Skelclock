/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages ship TypeScript source rather than a build step, so
  // Next has to compile them the same way it compiles the app.
  transpilePackages: ['@skelclock/core', '@skelclock/odoo', '@skelclock/server'],

  // `pg` is a native-ish driver and PGlite ships a WASM binary; neither
  // survives being bundled into the server chunk.
  serverExternalPackages: ['pg', '@electric-sql/pglite'],

  experimental: {
    // Workspace packages live outside the app directory.
    externalDir: true,
  },

  // The workspace packages use ESM-style specifiers ('./client.js') that point
  // at TypeScript sources, which is what Node's ESM loader and tsx require.
  // Webpack needs to be told that a '.js' specifier may resolve to a '.ts' file.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
