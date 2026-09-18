import { defineConfig } from 'vite';

/**
 * Dev server config for the HTML5 client.
 *
 * The backend (../server, port 8090) already serves the game data files
 * (bin-xml/*) and answers the PlayFish binary RPC protocol. In development the
 * client runs on :5173 and proxies those paths to the backend so cookies,
 * assets, and RPC all flow through the same origin.
 *
 * Start the backend first:  cd ../server && npm start
 */
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Binary RPC endpoints (see docs/05-network-protocol.md)
      '/g/rpc': { target: 'http://localhost:8090', changeOrigin: false },
      '/g/billing': { target: 'http://localhost:8090', changeOrigin: false },
      '/g/fbfeed': { target: 'http://localhost:8090', changeOrigin: false },
      // Raw game data files (ingredient.bin, recipe.bin, lang_en.bin, ...)
      '/bin-xml': { target: 'http://localhost:8090', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    // Protected ANEWON production builds must not publish client source maps.
    sourcemap: false,
    outDir: 'dist',
  },
});
