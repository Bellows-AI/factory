import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [tailwindcss(), react()],
    server: {
        // Unset on the host, where the default loopback bind is the access control. Set only by
        // docker-compose.yml, where a loopback bind is unreachable from the published port.
        host: process.env.VITE_DEV_HOST,
        port: 5173,
        proxy: { '/api': 'http://127.0.0.1:8080' },
    },
    build: { outDir: 'dist', sourcemap: true },
});
