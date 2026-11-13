import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
export default defineConfig({
    plugins: [react()],
    root: './src',
    base: '',
    build: {
        outDir: '../../apps/vscode-extension/dist/webview',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'src/main.tsx'),
            },
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: '[name].js',
                assetFileNames: '[name].[ext]',
            },
        },
        minify: false,
        sourcemap: true,
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
});
