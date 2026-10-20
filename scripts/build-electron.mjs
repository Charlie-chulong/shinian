import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist-electron', { recursive: true });
for (const name of ['main','preload']) {
  await build({ entryPoints: [`electron/${name}.ts`], outfile: `dist-electron/${name}.cjs`, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], sourcemap: false });
}
console.log('Electron 主进程和隔离桥接已构建。');
