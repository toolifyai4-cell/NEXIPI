import * as fs from 'fs';
import * as path from 'path';

function copyWasm() {
  // Try multiple possible locations for the WASM file
  const possibleSrcDirs = [
    path.resolve('../../node_modules/sql.js/dist'),  // Root node_modules (hoisted)
    path.resolve('node_modules/sql.js/dist'),       // Extension's own node_modules
  ];

  const destDir = path.resolve('dist');

  const wasmFiles = [
    'sql-wasm.wasm',
  ];

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  let srcDir = null;
  for (const dir of possibleSrcDirs) {
    if (fs.existsSync(path.join(dir, 'sql-wasm.wasm'))) {
      srcDir = dir;
      break;
    }
  }

  // Check pnpm store
  if (!srcDir) {
    const pnpmStoreDir = path.resolve('../../node_modules/.pnpm');
    if (fs.existsSync(pnpmStoreDir)) {
      const entries = fs.readdirSync(pnpmStoreDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('sql.js@')) {
          const candidateDir = path.join(pnpmStoreDir, entry.name, 'node_modules/sql.js/dist');
          if (fs.existsSync(path.join(candidateDir, 'sql-wasm.wasm'))) {
            srcDir = candidateDir;
            break;
          }
        }
      }
    }
  }

  if (!srcDir) {
    console.warn('WASM file not found in any known location');
    return;
  }

  for (const file of wasmFiles) {
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`Copied ${file} to dist/`);
    } else {
      console.warn(`WASM file not found: ${src}`);
    }
  }
}

copyWasm();