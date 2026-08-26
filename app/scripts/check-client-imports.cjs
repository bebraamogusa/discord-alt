const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '..', '..', 'client');
const files = [];

function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.name.endsWith('.js')) files.push(file);
  }
}

function namesFromModule(source) {
  const names = new Set();
  if (/\bexport\s+default\b/.test(source)) names.add('default');
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const item of match[1].split(',')) {
      const parts = item.trim().split(/\s+as\s+/);
      const name = parts.length > 1 ? parts[1] : parts[0];
      if (name) names.add(name);
    }
  }
  return names;
}

function moduleCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\r\n]*/gm, '');
}

collect(root);
const exportsByFile = new Map(files.map(file => [file, namesFromModule(moduleCode(fs.readFileSync(file, 'utf8')))]));
const errors = [];
const edges = new Map(files.map(file => [file, new Set()]));
const relative = file => path.relative(root, file).replaceAll(path.sep, '/');

function resolveLocal(file, specifier) {
  if (specifier.startsWith('/')) return path.resolve(root, `.${specifier}`);
  if (specifier.startsWith('.')) return path.resolve(path.dirname(file), specifier);
  return null;
}

function targetFor(file, specifier) {
  const target = resolveLocal(file, specifier);
  if (!target) return null;
  const targetFile = path.extname(target) ? target : `${target}.js`;
  return exportsByFile.has(targetFile) ? targetFile : targetFile;
}

function checkTarget(file, specifier, trackEdge = true) {
  if (/^(?:https?:|data:|blob:)/.test(specifier)) return null;
  const targetFile = targetFor(file, specifier);
  if (!targetFile) {
    errors.push(`${relative(file)} uses unsupported bare import ${specifier}`);
    return null;
  }
  if (!exportsByFile.has(targetFile)) {
    errors.push(`${relative(file)} imports missing module ${specifier}`);
    return null;
  }
  if (trackEdge) edges.get(file).add(targetFile);
  return targetFile;
}

function checkNamed(file, specifier, list) {
  const targetFile = checkTarget(file, specifier);
  if (!targetFile) return;
  const available = exportsByFile.get(targetFile);
  for (const item of list.split(',')) {
    const parts = item.trim().split(/\s+as\s+/);
    const name = parts[0];
    if (name && !available.has(name)) errors.push(`${relative(file)} imports ${name} from ${specifier}`);
  }
}

for (const file of files) {
  const source = moduleCode(fs.readFileSync(file, 'utf8'));
  for (const match of source.matchAll(/\bimport\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) checkNamed(file, match[2], match[1]);
  for (const match of source.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) checkNamed(file, match[2], match[1]);
  for (const match of source.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*)?from\s*['"]([^'"]+)['"]/g)) {
    const targetFile = checkTarget(file, match[2]);
    if (targetFile && !exportsByFile.get(targetFile).has('default')) errors.push(`${relative(file)} imports default from ${match[2]}`);
  }
  for (const match of source.matchAll(/\bimport\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s*['"]([^'"]+)['"]/g)) checkTarget(file, match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) checkTarget(file, match[1], false);
  for (const match of source.matchAll(/import\(['"]([^'"]+)['"]\)\s*\.then\s*\(\s*\(\s*\{([^}]*)\}/g)) {
    const targetFile = checkTarget(file, match[1], false);
    if (!targetFile) continue;
    const available = exportsByFile.get(targetFile);
    for (const item of match[2].split(',')) {
      const name = item.trim().split(/\s+as\s+/)[0];
      if (name && !available.has(name)) errors.push(`${relative(file)} imports ${name} from ${match[1]}`);
    }
  }
  for (const match of source.matchAll(/\bexport\s*\{[\s\S]*?\}\s*from\s*['"]([^'"]+)['"]/g)) checkTarget(file, match[1]);
  try {
    cp.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    errors.push(`${relative(file)} has invalid JavaScript syntax: ${String(error.stderr || error.message).trim()}`);
  }
}

const cycles = [];
const visiting = new Set();
const visited = new Set();
function visit(file, stack) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    cycles.push([...stack.slice(start), file].map(relative).join(' -> '));
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const target of edges.get(file)) visit(target, [...stack, file]);
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) visit(file, []);
for (const cycle of cycles) errors.push(`client ESM cycle: ${cycle}`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`client ESM imports passed (${files.length} modules)`);
}
