const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function build() {
  // Bundle the renderer entry point
  await esbuild.build({
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

  // Copy scaffold templates to dist
  const templatesSource = path.join(__dirname, 'assets/templates');
  const templatesDest = path.join(__dirname, 'dist/assets/templates');
  if (fs.existsSync(templatesSource)) {
    copyDirRecursive(templatesSource, templatesDest);
  }

  console.log('Renderer bundled successfully');
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
