import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ScaffoldTemplate, ScaffoldTemplateInfo, ScaffoldRequest, ScaffoldResult } from '../shared/types';

// File extensions that support variable substitution
const SUBSTITUTION_EXTENSIONS = new Set([
  '.md', '.json', '.txt', '.toml', '.yaml', '.yml', '.cfg', '.ini',
  '.env', '.gitignore', '.clineignore', '.ts', '.js', '.py', '.html',
  '.css', '.xml', '.sh', '.bat', '.ps1', '.nvmrc', '.python-version',
]);

function getBuiltinTemplatesDir(): string {
  // In production, resources are at process.resourcesPath/assets/templates
  // In dev, they're at project root assets/templates
  const prodPath = path.join(process.resourcesPath, 'assets', 'templates');
  if (fs.existsSync(prodPath)) {
    return prodPath;
  }
  // Dev fallback: walk up from dist/main to project root
  return path.join(__dirname, '..', '..', 'assets', 'templates');
}

function getLocalTemplatesDir(): string {
  // %APPDATA%/tarca-terminal/templates/
  return path.join(app.getPath('userData'), 'templates');
}

function tryReadManifest(templateDir: string): ScaffoldTemplate | null {
  const manifestPath = path.join(templateDir, 'template.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as ScaffoldTemplate;
    if (!manifest.name || !manifest.description) return null;
    return manifest;
  } catch {
    console.warn(`Failed to parse template.json in ${templateDir}`);
    return null;
  }
}

export function listScaffoldTemplates(): ScaffoldTemplateInfo[] {
  const results: ScaffoldTemplateInfo[] = [];

  // Scan builtin templates
  const builtinDir = getBuiltinTemplatesDir();
  if (fs.existsSync(builtinDir)) {
    try {
      const entries = fs.readdirSync(builtinDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const templateDir = path.join(builtinDir, entry.name);
        const manifest = tryReadManifest(templateDir);
        if (manifest) {
          results.push({ manifest, path: templateDir, source: 'builtin' });
        }
      }
    } catch (err) {
      console.warn('Failed to scan builtin templates:', err);
    }
  }

  // Scan local templates
  const localDir = getLocalTemplatesDir();
  if (fs.existsSync(localDir)) {
    try {
      const entries = fs.readdirSync(localDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const templateDir = path.join(localDir, entry.name);
        const manifest = tryReadManifest(templateDir);
        if (manifest) {
          results.push({ manifest, path: templateDir, source: 'local' });
        }
      }
    } catch (err) {
      console.warn('Failed to scan local templates:', err);
    }
  }

  // Sort: builtin first (alphabetical), then local (alphabetical)
  results.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1;
    return a.manifest.name.localeCompare(b.manifest.name);
  });

  return results;
}

function copyDirRecursive(src: string, dest: string, excludeFiles: Set<string>): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeFiles.has(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, excludeFiles);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function substituteVariables(filePath: string, variables: Record<string, string>): void {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  // Check if file supports substitution (by extension or dotfile name)
  const isDotfile = basename.startsWith('.') && !ext;
  const isSubstitutable = SUBSTITUTION_EXTENSIONS.has(ext) ||
    (isDotfile && SUBSTITUTION_EXTENSIONS.has(basename));

  if (!isSubstitutable) return;

  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    let changed = false;

    for (const [key, value] of Object.entries(variables)) {
      const pattern = `{{${key}}}`;
      if (content.includes(pattern)) {
        content = content.split(pattern).join(value);
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  } catch {
    // Skip files that can't be read as text
  }
}

function substituteDir(dir: string, variables: Record<string, string>): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteDir(fullPath, variables);
    } else {
      substituteVariables(fullPath, variables);
    }
  }
}

export function scaffoldProject(request: ScaffoldRequest): ScaffoldResult {
  const { templatePath, projectName, parentDir, variables } = request;

  // Validate project name
  const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
  if (!projectName || invalidChars.test(projectName)) {
    return { success: false, projectDir: '', error: 'Invalid project name' };
  }

  // Validate parent dir exists
  if (!fs.existsSync(parentDir)) {
    return { success: false, projectDir: '', error: `Parent directory does not exist: ${parentDir}` };
  }

  const projectDir = path.join(parentDir, projectName);

  // Check target doesn't already exist
  if (fs.existsSync(projectDir)) {
    return { success: false, projectDir, error: `Directory already exists: ${projectDir}` };
  }

  try {
    // Create project directory
    fs.mkdirSync(projectDir, { recursive: true });

    // Copy template files, excluding template.json
    if (fs.existsSync(templatePath)) {
      copyDirRecursive(templatePath, projectDir, new Set(['template.json']));
    }

    // Build variable map — always inject PROJECT_NAME
    const allVars: Record<string, string> = {
      PROJECT_NAME: projectName,
      ...variables,
    };

    // Run variable substitution
    substituteDir(projectDir, allVars);

    return { success: true, projectDir };
  } catch (err: any) {
    return { success: false, projectDir, error: err.message || 'Scaffold failed' };
  }
}
