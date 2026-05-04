const express = require('express');
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3456;

const CLAUDE_DIR = path.join(process.env.HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const GLOBAL_CLAUDE_MD = path.join(process.env.HOME, 'CLAUDE.md');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== Auto-discover all projects with memory =====
function discoverProjects() {
  const projects = [];
  if (!fs.existsSync(PROJECTS_DIR)) return projects;

  for (const dirName of fs.readdirSync(PROJECTS_DIR)) {
    const memDir = path.join(PROJECTS_DIR, dirName, 'memory');
    if (!fs.existsSync(memDir) || !fs.statSync(memDir).isDirectory()) continue;

    // Decode project path from directory name: -Users-heart → /Users/heart
    const decodedPath = dirName.replace(/^-/, '').replace(/-/g, '/');
    const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) continue;

    projects.push({
      id: dirName,
      displayPath: '/' + decodedPath,
      memoryDir: memDir,
      fileCount: files.length,
    });
  }
  return projects;
}

// Get memory dir — use env var, or auto-discover the largest project
function getMemoryDir() {
  if (process.env.MEMORY_DIR) return process.env.MEMORY_DIR;
  const projects = discoverProjects();
  if (projects.length === 0) return null;
  // Pick the project with the most files
  projects.sort((a, b) => b.fileCount - a.fileCount);
  return projects[0].memoryDir;
}

// ===== Scan memory files =====
function scanMemoryDir(memoryDir) {
  const files = [];
  if (!memoryDir || !fs.existsSync(memoryDir)) return files;

  for (const name of fs.readdirSync(memoryDir)) {
    const fp = path.join(memoryDir, name);
    const stat = fs.statSync(fp);
    if (!stat.isFile() || !name.endsWith('.md')) continue;

    const raw = fs.readFileSync(fp, 'utf-8');
    let frontmatter = {};
    let content = raw;
    try {
      const parsed = matter(raw);
      frontmatter = parsed.data;
      content = parsed.content;
    } catch {}

    files.push({
      name,
      path: fp,
      relativePath: `memory/${name}`,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      content,
      raw,
      frontmatter,
      type: frontmatter.type || guessType(name),
      description: frontmatter.description || '',
      memoryName: frontmatter.name || '',
    });
  }

  // Also include global CLAUDE.md
  if (fs.existsSync(GLOBAL_CLAUDE_MD)) {
    const stat = fs.statSync(GLOBAL_CLAUDE_MD);
    const raw = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf-8');
    files.push({
      name: 'CLAUDE.md',
      path: GLOBAL_CLAUDE_MD,
      relativePath: 'CLAUDE.md (global)',
      size: stat.size,
      modified: stat.mtime.toISOString(),
      content: raw,
      raw,
      frontmatter: {},
      type: 'global',
      description: 'Global project instructions',
      memoryName: 'Global CLAUDE.md',
    });
  }

  return files;
}

function guessType(name) {
  if (name.startsWith('feedback_')) return 'feedback';
  if (name.startsWith('user_')) return 'user';
  if (name.startsWith('project_')) return 'project';
  if (name.startsWith('ref_')) return 'reference';
  if (name === 'MEMORY.md') return 'index';
  return 'other';
}

// ===== Parse MEMORY.md index topology =====
function parseMemoryIndex(memoryDir) {
  const memoryFile = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(memoryFile)) return null;

  const raw = fs.readFileSync(memoryFile, 'utf-8');
  const sections = [];
  let currentSection = null;

  for (const line of raw.split('\n')) {
    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);
    if (h2) {
      currentSection = { title: h2[1], level: 2, children: [] };
      sections.push(currentSection);
      continue;
    }
    if (h3) {
      const subsection = { title: h3[1], level: 3, children: [] };
      if (currentSection) {
        currentSection.children.push(subsection);
      } else {
        sections.push(subsection);
      }
      currentSection = subsection;
      continue;
    }

    const linkMatch = line.match(/^- \*?\*?\[(.+?)\]\(\.\/(.+?)\)\*?\*?\s*[—–-]\s*(.*)/);
    if (linkMatch && currentSection) {
      currentSection.children.push({
        type: 'leaf', label: linkMatch[1], file: linkMatch[2], description: linkMatch[3].trim(),
      });
      continue;
    }

    const linkSimple = line.match(/^- \*?\*?\[(.+?)\]\(\.\/(.+?)\)\*?\*?/);
    if (linkSimple && currentSection) {
      currentSection.children.push({
        type: 'leaf', label: linkSimple[1], file: linkSimple[2], description: '',
      });
    }

    if (line.startsWith('|') && !line.match(/^\|[-\s|]+\|$/)) {
      if (currentSection && !currentSection.table) currentSection.table = [];
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
      if (currentSection?.table && cells.length > 0 && cells[0] !== '位置') {
        currentSection.table.push(cells);
      }
    }
  }

  return { raw, sections };
}

// Token estimation (~4 chars/token for mixed CJK/English)
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿　-〿＀-￯]/g) || []).length;
  const ascii = text.length - cjk;
  return Math.round(cjk * 1.5 + ascii / 4);
}

// ===== Change detection hash =====
function computeFingerprint(memoryDir) {
  const files = scanMemoryDir(memoryDir);
  const hash = crypto.createHash('md5');
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(`${f.name}:${f.modified}:${f.size}`);
  }
  return hash.digest('hex');
}

// ===== API Routes =====

// List all discovered projects
app.get('/api/projects', (req, res) => {
  res.json(discoverProjects());
});

// Get all files with full data
app.get('/api/files', (req, res) => {
  const memoryDir = getMemoryDir();
  if (!memoryDir) return res.status(404).json({ error: 'No memory directory found' });

  const files = scanMemoryDir(memoryDir);
  const index = parseMemoryIndex(memoryDir);

  const withTokens = files.map(f => ({ ...f, tokens: estimateTokens(f.raw) }));
  const totalTokens = withTokens.reduce((s, f) => s + f.tokens, 0);
  const duplicates = findDuplicates(files, memoryDir);

  res.json({
    files: withTokens,
    index,
    tokenBudget: {
      total: totalTokens,
      byType: groupByType(withTokens),
      byFile: withTokens.map(f => ({ name: f.name, tokens: f.tokens, type: f.type })),
    },
    duplicates,
    summary: {
      totalFiles: files.length,
      totalSize: files.reduce((s, f) => s + f.size, 0),
      types: countByType(files),
    },
    meta: {
      memoryDir,
      projectPath: discoverProjects().find(p => p.memoryDir === memoryDir)?.displayPath || '',
      fingerprint: computeFingerprint(memoryDir),
    },
  });
});

// Lightweight change detection (returns just a hash)
app.get('/api/changes', (req, res) => {
  const memoryDir = getMemoryDir();
  if (!memoryDir) return res.json({ fingerprint: null });
  res.json({ fingerprint: computeFingerprint(memoryDir) });
});

// Get single file content
app.get('/api/file/:name', (req, res) => {
  const memoryDir = getMemoryDir();
  if (!memoryDir) return res.status(404).json({ error: 'No memory directory' });

  const fp = path.join(memoryDir, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });

  const raw = fs.readFileSync(fp, 'utf-8');
  let frontmatter = {}, content = raw;
  try {
    const parsed = matter(raw);
    frontmatter = parsed.data;
    content = parsed.content;
  } catch {}

  res.json({ name: req.params.name, raw, content, frontmatter, tokens: estimateTokens(raw) });
});

// Save file content back to disk
app.post('/api/save', (req, res) => {
  const memoryDir = getMemoryDir();
  if (!memoryDir) return res.status(404).json({ error: 'No memory directory' });

  const { name, content } = req.body;
  if (!name || content === undefined) {
    return res.status(400).json({ error: 'Missing name or content' });
  }

  const fp = path.join(memoryDir, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });

  // Backup before save
  fs.copyFileSync(fp, fp + '.bak');
  fs.writeFileSync(fp, content, 'utf-8');
  res.json({ ok: true, saved: fp, tokens: estimateTokens(content) });
});

// ===== Duplicate detection =====
function findDuplicates(files, memoryDir) {
  const dupes = [];

  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const sim = titleSimilarity(files[i].name, files[j].name);
      if (sim > 0.6) {
        dupes.push({ type: 'title-similar', files: [files[i].name, files[j].name], similarity: sim });
      }
    }
  }

  const memoryIndex = parseMemoryIndex(memoryDir);
  if (memoryIndex) {
    const refCount = {};
    const linkPattern = /\[.+?\]\(\.\/(.+?)\)/g;
    let m;
    while ((m = linkPattern.exec(memoryIndex.raw))) {
      refCount[m[1]] = (refCount[m[1]] || 0) + 1;
    }
    for (const [target, count] of Object.entries(refCount)) {
      if (count > 1) {
        dupes.push({ type: 'multi-ref', files: [`${target} (${count} references)`], similarity: 1 });
      }
    }
  }

  const descriptions = files.filter(f => f.description).map(f => ({ name: f.name, desc: f.description.toLowerCase() }));
  for (let i = 0; i < descriptions.length; i++) {
    for (let j = i + 1; j < descriptions.length; j++) {
      const sim = titleSimilarity(descriptions[i].desc, descriptions[j].desc);
      if (sim > 0.7) {
        dupes.push({ type: 'description-similar', files: [descriptions[i].name, descriptions[j].name], similarity: sim });
      }
    }
  }

  return dupes;
}

function titleSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().replace(/[_\-\.]/g, ' ').split(/\s+/));
  const setB = new Set(b.toLowerCase().replace(/[_\-\.]/g, ' ').split(/\s+/));
  const intersection = [...setA].filter(x => setB.has(x));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

function groupByType(files) {
  const groups = {};
  for (const f of files) groups[f.type] = (groups[f.type] || 0) + f.tokens;
  return groups;
}

function countByType(files) {
  const counts = {};
  for (const f of files) counts[f.type] = (counts[f.type] || 0) + 1;
  return counts;
}

// Export all data as JSON (for cloud version)
app.get('/api/export', (req, res) => {
  const memoryDir = getMemoryDir();
  if (!memoryDir) return res.status(404).json({ error: 'No memory directory' });

  const files = scanMemoryDir(memoryDir);
  const index = parseMemoryIndex(memoryDir);
  const withTokens = files.map(f => ({ ...f, tokens: estimateTokens(f.raw) }));
  const totalTokens = withTokens.reduce((s, f) => s + f.tokens, 0);

  res.setHeader('Content-Disposition', 'attachment; filename=claude-memory-export.json');
  res.json({
    version: 1,
    exportedAt: new Date().toISOString(),
    projectPath: discoverProjects().find(p => p.memoryDir === memoryDir)?.displayPath || '',
    files: withTokens.map(f => ({
      name: f.name, raw: f.raw, type: f.type,
      description: f.description, memoryName: f.memoryName,
      size: f.size, tokens: f.tokens,
    })),
    index: index ? index.raw : null,
    tokenBudget: {
      total: totalTokens,
      byType: groupByType(withTokens),
    },
  });
});

app.listen(PORT, () => {
  const memoryDir = getMemoryDir();
  const projects = discoverProjects();
  console.log(`\n🧠 Claude Memory UI running at http://localhost:${PORT}\n`);
  console.log(`   Discovered projects: ${projects.length}`);
  projects.forEach(p => console.log(`     ${p.displayPath} → ${p.fileCount} files`));
  console.log(`\n   Active memory dir: ${memoryDir || 'NONE'}`);
  console.log(`   Global CLAUDE.md: ${fs.existsSync(GLOBAL_CLAUDE_MD) ? 'found' : 'not found'}\n`);
});
