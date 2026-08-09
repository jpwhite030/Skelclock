import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The repo keeps one .env at the monorepo root (matches .env.example and
// every script under scripts/), but Next's own env loading only ever looks
// inside this app's own directory. Without this, DATABASE_URL and the
// Supabase vars are silently undefined here even though they're set — the
// app falls back to the in-process demo database instead of failing loudly.
// Node's own loadEnvFile never overwrites a var the environment already set,
// so this is a no-op in CI/production where those are set directly.
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'));
} catch {
  // No root .env — fine locally in demo mode, and expected in CI/production.
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages ship TypeScript source rather than a build step, so
  // Next has to compile them the same way it compiles the app.
  transpilePackages: ['@skelclock/contracts', '@skelclock/core', '@skelclock/odoo', '@skelclock/server'],

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
