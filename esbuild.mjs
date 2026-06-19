import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Host: Node CJS bundle (external vscode). */
const hostOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
};

/** Webview: browser IIFE bundle served to the webview under the CSP nonce. */
const webviewOptions = {
  entryPoints: ['media/src/panel.js'],
  bundle: true,
  outfile: 'dist/panel.js',
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'], // VS Code's bundled Chromium
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const hostCtx = await esbuild.context(hostOptions);
  const webCtx = await esbuild.context(webviewOptions);
  await Promise.all([hostCtx.watch(), webCtx.watch()]);
  console.log('esbuild watching (host + webview)…');
} else {
  await esbuild.build(hostOptions);
  await esbuild.build(webviewOptions);
}
