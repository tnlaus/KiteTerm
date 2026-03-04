import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { LibraryEntry, LibraryInstallation, LibraryPushRequest, LibraryWorkspaceView, LibrarySyncStatus, DiscoveredItem } from '../shared/types';
import { getLibraryIndex, setLibraryIndex, getInstallations, setInstallations, getWorkspaces } from './store';

// ============================================
// Library Directory
// ============================================

export function getLibraryDir(): string {
  const dir = path.join(app.getPath('userData'), 'skills-library');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  }
  return dir;
}

// ============================================
// Content Hashing
// ============================================

export function computeContentHash(itemPath: string): string {
  const hash = crypto.createHash('sha256');

  if (fs.statSync(itemPath).isDirectory()) {
    const files = collectFiles(itemPath);
    // Sort for deterministic hashing
    files.sort((a, b) => a.relative.localeCompare(b.relative));
    for (const f of files) {
      hash.update(f.relative);
      hash.update(fs.readFileSync(f.absolute));
    }
  } else {
    hash.update(fs.readFileSync(itemPath));
  }

  return hash.digest('hex');
}

interface FileEntry {
  relative: string;
  absolute: string;
}

function collectFiles(dir: string, base?: string): FileEntry[] {
  const result: FileEntry[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...collectFiles(abs, rel));
    } else {
      result.push({ relative: rel, absolute: abs });
    }
  }
  return result;
}

// ============================================
// Frontmatter Parser
// ============================================

export function parseFrontmatter(mdContent: string): { name: string; description: string } {
  const match = mdContent.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    // No frontmatter — derive name from first heading
    const headingMatch = mdContent.match(/^#\s+(.+)/m);
    return {
      name: headingMatch ? headingMatch[1].trim() : '',
      description: '',
    };
  }

  const yaml = match[1];
  let name = '';
  let description = '';

  const nameMatch = yaml.match(/^name:\s*["']?(.+?)["']?\s*$/m);
  if (nameMatch) name = nameMatch[1].trim();

  const descMatch = yaml.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  if (descMatch) description = descMatch[1].trim();

  return { name, description };
}

// ============================================
// Slug Helper
// ============================================

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================
// Import
// ============================================

export function importToLibrary(sourcePath: string, type: 'skill' | 'agent'): LibraryEntry {
  const libDir = getLibraryDir();
  const isFolder = fs.statSync(sourcePath).isDirectory();
  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const id = toSlug(baseName);
  const targetSubdir = type === 'skill' ? 'skills' : 'agents';
  const targetPath = path.join(libDir, targetSubdir, isFolder ? baseName : `${baseName}.md`);

  // Copy to library
  if (isFolder) {
    copyDirRecursive(sourcePath, targetPath);
  } else {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }

  // Parse frontmatter from the primary .md file
  let mdContent = '';
  if (isFolder) {
    // Look for SKILL.md or agent .md (first .md found)
    const skillMd = path.join(targetPath, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      mdContent = fs.readFileSync(skillMd, 'utf-8');
    } else {
      const mdFiles = fs.readdirSync(targetPath).filter(f => f.endsWith('.md'));
      if (mdFiles.length > 0) {
        mdContent = fs.readFileSync(path.join(targetPath, mdFiles[0]), 'utf-8');
      }
    }
  } else {
    mdContent = fs.readFileSync(targetPath, 'utf-8');
  }

  const { name, description } = parseFrontmatter(mdContent);
  const contentHash = computeContentHash(targetPath);
  const now = Date.now();

  const entry: LibraryEntry = {
    id,
    type,
    name: name || baseName,
    description,
    contentHash,
    isFolder,
    addedAt: now,
    updatedAt: now,
  };

  // Update index — replace existing entry with same id+type or add new
  const index = getLibraryIndex();
  const existingIdx = index.findIndex(e => e.id === id && e.type === type);
  if (existingIdx >= 0) {
    entry.addedAt = index[existingIdx].addedAt;
    index[existingIdx] = entry;
  } else {
    index.push(entry);
  }
  setLibraryIndex(index);

  return entry;
}

// ============================================
// Remove
// ============================================

export function removeFromLibrary(entryId: string): void {
  const index = getLibraryIndex();
  const entry = index.find(e => e.id === entryId);
  if (!entry) return;

  // Delete from disk
  const libDir = getLibraryDir();
  const subdir = entry.type === 'skill' ? 'skills' : 'agents';
  const itemPath = path.join(libDir, subdir, entry.isFolder ? entry.id : `${entry.id}.md`);

  // Also try the name-based path (slug may differ from folder name)
  if (fs.existsSync(itemPath)) {
    if (entry.isFolder) {
      fs.rmSync(itemPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(itemPath);
    }
  }

  // Remove from index
  setLibraryIndex(index.filter(e => e.id !== entryId));
}

// ============================================
// Refresh (re-scan disk)
// ============================================

export function refreshLibrary(): LibraryEntry[] {
  const libDir = getLibraryDir();
  const entries: LibraryEntry[] = [];
  const existingIndex = getLibraryIndex();

  for (const type of ['skills', 'agents'] as const) {
    const typeDir = path.join(libDir, type);
    if (!fs.existsSync(typeDir)) continue;

    const items = fs.readdirSync(typeDir, { withFileTypes: true });
    for (const item of items) {
      const itemPath = path.join(typeDir, item.name);
      const isFolder = item.isDirectory();
      const baseName = isFolder ? item.name : path.basename(item.name, path.extname(item.name));
      const id = toSlug(baseName);
      const entryType = type === 'skills' ? 'skill' : 'agent';

      // Skip non-.md single files
      if (!isFolder && !item.name.endsWith('.md')) continue;

      // Parse frontmatter
      let mdContent = '';
      if (isFolder) {
        const skillMd = path.join(itemPath, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          mdContent = fs.readFileSync(skillMd, 'utf-8');
        } else {
          const mdFiles = fs.readdirSync(itemPath).filter(f => f.endsWith('.md'));
          if (mdFiles.length > 0) {
            mdContent = fs.readFileSync(path.join(itemPath, mdFiles[0]), 'utf-8');
          }
        }
      } else {
        mdContent = fs.readFileSync(itemPath, 'utf-8');
      }

      const { name, description } = parseFrontmatter(mdContent);
      const contentHash = computeContentHash(itemPath);
      const now = Date.now();

      // Preserve addedAt from existing index
      const existing = existingIndex.find(e => e.id === id && e.type === entryType);

      entries.push({
        id,
        type: entryType,
        name: name || baseName,
        description,
        contentHash,
        isFolder,
        addedAt: existing?.addedAt || now,
        updatedAt: now,
      });
    }
  }

  setLibraryIndex(entries);
  return entries;
}

// ============================================
// Push to Workspaces
// ============================================

export function pushToWorkspaces(request: LibraryPushRequest): { pushed: number; errors: string[] } {
  const index = getLibraryIndex();
  const workspaces = getWorkspaces();
  const errors: string[] = [];
  let pushed = 0;

  for (const entryId of request.entryIds) {
    const entry = index.find(e => e.id === entryId);
    if (!entry) {
      errors.push(`Entry not found: ${entryId}`);
      continue;
    }

    const libDir = getLibraryDir();
    const subdir = entry.type === 'skill' ? 'skills' : 'agents';
    const sourcePath = path.join(libDir, subdir, entry.isFolder ? entry.id : `${entry.id}.md`);

    if (!fs.existsSync(sourcePath)) {
      errors.push(`Source not found on disk: ${entryId}`);
      continue;
    }

    for (const wsId of request.workspaceIds) {
      const ws = workspaces.find(w => w.id === wsId);
      if (!ws) {
        errors.push(`Workspace not found: ${wsId}`);
        continue;
      }

      try {
        const claudeDir = path.join(ws.cwd, '.claude');
        const targetSubdir = entry.type === 'skill' ? 'skills' : 'agents';
        const targetDir = path.join(claudeDir, targetSubdir);

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const targetPath = path.join(targetDir, entry.isFolder ? entry.id : `${entry.id}.md`);

        if (entry.isFolder) {
          // Remove existing before copy
          if (fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
          }
          copyDirRecursive(sourcePath, targetPath);
        } else {
          fs.copyFileSync(sourcePath, targetPath);
        }

        // Update installation record
        const installations = getInstallations(wsId);
        const existingIdx = installations.findIndex(i => i.entryId === entryId);
        const record: LibraryInstallation = {
          entryId,
          contentHash: entry.contentHash,
          pushedAt: Date.now(),
        };
        if (existingIdx >= 0) {
          installations[existingIdx] = record;
        } else {
          installations.push(record);
        }
        setInstallations(wsId, installations);
        pushed++;
      } catch (err: any) {
        errors.push(`Failed to push ${entryId} to ${ws.name}: ${err.message}`);
      }
    }
  }

  return { pushed, errors };
}

// ============================================
// Workspace View
// ============================================

export function getWorkspaceView(workspaceId: string): LibraryWorkspaceView[] {
  const index = getLibraryIndex();
  const installations = getInstallations(workspaceId);
  const views: LibraryWorkspaceView[] = [];

  for (const entry of index) {
    const installation = installations.find(i => i.entryId === entry.id);

    let status: LibrarySyncStatus = 'not-installed';
    if (installation) {
      status = installation.contentHash === entry.contentHash ? 'installed' : 'update-available';
    }

    views.push({
      entry,
      status,
      installedHash: installation?.contentHash,
      pushedAt: installation?.pushedAt,
    });
  }

  return views;
}

// ============================================
// Scan Workspace (discover untracked items)
// ============================================

export function scanWorkspaceForItems(workspaceId: string): LibraryEntry[] {
  const workspaces = getWorkspaces();
  const ws = workspaces.find(w => w.id === workspaceId);
  if (!ws) return [];

  const discovered: LibraryEntry[] = [];
  const claudeDir = path.join(ws.cwd, '.claude');
  if (!fs.existsSync(claudeDir)) return [];

  const index = getLibraryIndex();

  for (const type of ['skills', 'agents'] as const) {
    const dir = path.join(claudeDir, type);
    if (!fs.existsSync(dir)) continue;

    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const itemPath = path.join(dir, item.name);
      const isFolder = item.isDirectory();
      const baseName = isFolder ? item.name : path.basename(item.name, path.extname(item.name));
      const id = toSlug(baseName);
      const entryType = type === 'skills' ? 'skill' : 'agent';

      if (!isFolder && !item.name.endsWith('.md')) continue;

      // Skip if already in library
      if (index.find(e => e.id === id && e.type === entryType)) continue;

      let mdContent = '';
      if (isFolder) {
        const skillMd = path.join(itemPath, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          mdContent = fs.readFileSync(skillMd, 'utf-8');
        } else {
          const mdFiles = fs.readdirSync(itemPath).filter(f => f.endsWith('.md'));
          if (mdFiles.length > 0) {
            mdContent = fs.readFileSync(path.join(itemPath, mdFiles[0]), 'utf-8');
          }
        }
      } else {
        mdContent = fs.readFileSync(itemPath, 'utf-8');
      }

      const { name, description } = parseFrontmatter(mdContent);
      const contentHash = computeContentHash(itemPath);

      discovered.push({
        id,
        type: entryType,
        name: name || baseName,
        description,
        contentHash,
        isFolder,
        addedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  return discovered;
}

// ============================================
// Discover from Workspaces
// ============================================

export function discoverFromWorkspace(workspaceId: string): DiscoveredItem[] {
  const workspaces = getWorkspaces();
  const ws = workspaces.find(w => w.id === workspaceId);
  if (!ws) return [];

  const claudeDir = path.join(ws.cwd, '.claude');
  if (!fs.existsSync(claudeDir)) return [];

  const index = getLibraryIndex();
  const discovered: DiscoveredItem[] = [];

  for (const type of ['skills', 'agents'] as const) {
    const dir = path.join(claudeDir, type);
    if (!fs.existsSync(dir)) continue;

    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const itemPath = path.join(dir, item.name);
      const isFolder = item.isDirectory();
      const baseName = isFolder ? item.name : path.basename(item.name, path.extname(item.name));
      const id = toSlug(baseName);
      const entryType = type === 'skills' ? 'skill' : 'agent';

      if (!isFolder && !item.name.endsWith('.md')) continue;

      // Skip if already in library
      if (index.find(e => e.id === id && e.type === entryType)) continue;

      let mdContent = '';
      if (isFolder) {
        const skillMd = path.join(itemPath, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          mdContent = fs.readFileSync(skillMd, 'utf-8');
        } else {
          const mdFiles = fs.readdirSync(itemPath).filter(f => f.endsWith('.md'));
          if (mdFiles.length > 0) {
            mdContent = fs.readFileSync(path.join(itemPath, mdFiles[0]), 'utf-8');
          }
        }
      } else {
        mdContent = fs.readFileSync(itemPath, 'utf-8');
      }

      const { name, description } = parseFrontmatter(mdContent);
      const contentHash = computeContentHash(itemPath);
      const now = Date.now();

      discovered.push({
        entry: {
          id,
          type: entryType,
          name: name || baseName,
          description,
          contentHash,
          isFolder,
          addedAt: now,
          updatedAt: now,
        },
        sourcePath: itemPath,
        workspaceId: ws.id,
        workspaceName: ws.name,
      });
    }
  }

  return discovered;
}

export function discoverFromAllWorkspaces(): DiscoveredItem[] {
  const workspaces = getWorkspaces();
  const all: DiscoveredItem[] = [];
  const seen = new Set<string>(); // track id+type to avoid duplicates across workspaces

  for (const ws of workspaces) {
    const items = discoverFromWorkspace(ws.id);
    for (const item of items) {
      const key = `${item.entry.id}:${item.entry.type}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(item);
      }
    }
  }

  return all;
}

// ============================================
// File Copy Helper (reused from scaffolder pattern)
// ============================================

function copyDirRecursive(src: string, dest: string): void {
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
