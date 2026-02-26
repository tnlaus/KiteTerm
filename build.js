const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

// Bundle the renderer entry point
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'src/renderer/index.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'dist/renderer/index.js'),
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  sourcemap: true,
  external: ['electron'],
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
  },
});

// Copy static assets to dist
const rendererDist = path.join(__dirname, 'dist/renderer');
const stylesDir = path.join(rendererDist, 'styles');

if (!fs.existsSync(stylesDir)) {
  fs.mkdirSync(stylesDir, { recursive: true });
}

// Copy HTML
fs.copyFileSync(
  path.join(__dirname, 'src/renderer/index.html'),
  path.join(rendererDist, 'index.html')
);

// Copy CSS
fs.copyFileSync(
  path.join(__dirname, 'src/renderer/styles/global.css'),
  path.join(stylesDir, 'global.css')
);

// Copy xterm.css from node_modules
const xtermCssSource = path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css');
if (fs.existsSync(xtermCssSource)) {
  fs.copyFileSync(xtermCssSource, path.join(stylesDir, 'xterm.css'));
}

console.log('✓ Renderer bundled successfully');
