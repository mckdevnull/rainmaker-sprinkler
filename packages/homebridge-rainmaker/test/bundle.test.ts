import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(pkgDir, 'dist', 'index.js');

describe('published bundle', () => {
  beforeAll(() => {
    // The esbuild step only (~1 s): bundles hub-core into dist/index.js.
    execFileSync('npm', ['run', 'build', '--silent'], { cwd: pkgDir, stdio: 'pipe', shell: process.platform === 'win32' });
  }, 30_000);

  it('dist/index.js loads in plain Node and exports a function', () => {
    const script = `import(${JSON.stringify(pathToFileURL(dist).href)}).then((m) => process.exit(typeof m.default === 'function' ? 0 : 1), (e) => { console.error(e); process.exit(2); })`;
    expect(() => execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' })).not.toThrow();
  });
});
