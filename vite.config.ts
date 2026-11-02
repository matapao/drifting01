import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so dist/ works from any path, not just the domain root.
  base: './',
  // Its own port: Vite only checks `localhost`, so it can land on 5173 while another project holds 127.0.0.1:5173.
  server: { port: 5180 },
});
