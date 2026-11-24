import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SEMVER = /^dsh-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const upstream = 'https://github.com/deepseek-ai/deepseek-harness';
export const runners = Object.freeze({ 'win-x64': 'windows-2025', 'win-arm64': 'windows-2025', 'darwin-arm64': 'macos-15', 'darwin-x64': 'macos-15-intel' });

export function checkedTag(value) {
  const match = typeof value === 'string' && value.length <= 100 && SEMVER.exec(value);
  if (!match || match[1]?.split('.').some((part) => /^0\d+$/.test(part))) {
    throw new Error(`无效的上游标签：${JSON.stringify(value)}`);
  }
  return value;
}

export function checkedCommit(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error('上游提交必须是完整的小写 Git SHA。');
  }
  return value;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function checkedSource(value, expected) {
  if (value?.schemaVersion !== 1 || checkedTag(value.tag) !== expected.tag || checkedCommit(value.commit) !== expected.commit ||
    value.prerelease !== expected.prerelease || typeof value.prerelease !== 'boolean' || !Array.isArray(value.targets) ||
    !value.sources || typeof value.sources !== 'object' || Object.values(value.sources).some((source) => typeof source !== 'string' || source.startsWith('/') || source.includes('..')) ||
    new Set(value.targets).size !== value.targets.length || value.targets.some((target) => !Object.hasOwn(runners, target))) {
    throw new Error(`${expected.tag} 的快照清单与上游计划不符。`);
  }
  return value;
}

export function assetName(tag, target) {
  checkedTag(tag);
  if (!Object.hasOwn(runners, target)) {
    throw new Error(`不支持的发布目标：${target}`);
  }
  return `cua-helper-${tag}-${target}.zip`;
}

export function provenance(source) {
  return `<!-- dsh-cua-helper:${source.tag}:${source.commit} -->`;
}

export function completeRelease(release, source) {
  if (!release || release.draft || release.prerelease !== source.prerelease || release.tag_name !== source.tag ||
    !release.body?.includes(provenance(source))) {
    return false;
  }
  const expected = [...source.targets.map((target) => assetName(source.tag, target)), 'SHA256SUMS'];
  return expected.every((name) => release.assets.some((asset) =>
    asset.name === name && asset.state === 'uploaded' && asset.size > 0 && /^sha256:[0-9a-f]{64}$/.test(asset.digest ?? '')));
}

export function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${program} ${args[0]} 失败 (${result.status ?? result.signal})：${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout?.trim() ?? '';
}

export function git(args, cwd) {
  return command('git', args, { cwd });
}

export function repository() {
  const value = process.env.GITHUB_REPOSITORY;
  if (!/^[0-9A-Za-z-]+\/[0-9A-Za-z_.-]+$/.test(value ?? '')) {
    throw new Error('缺少有效的 GITHUB_REPOSITORY。');
  }
  return value;
}

export async function releaseMap(repo, token = process.env.GH_TOKEN) {
  const releases = new Map();
  for (let page = 1; ; page++) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-cua-helper' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`无法列出镜像 Release：HTTP ${response.status}`);
    }
    const items = await response.json();
    for (const item of items) {
      const existing = releases.get(item.tag_name);
      if (!existing || existing.draft) {
        releases.set(item.tag_name, item);
      }
    }
    if (items.length < 100) {
      return releases;
    }
  }
}

export function sourceAt(ref, tag) {
  const file = `${ref}:versions/${checkedTag(tag)}/source.json`;
  const result = spawnSync('git', ['cat-file', '-e', file], { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return JSON.parse(git(['show', file]));
  }
  return undefined;
}

export function batch(plans, hour, size = 8) {
  if (plans.length <= size) {
    return plans;
  }
  const start = (hour % Math.ceil(plans.length / size)) * size;
  return plans.slice(start, start + size);
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function regularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || !stat.size) {
    throw new Error(`缺少常规非空文件：${path}`);
  }
  return stat;
}

export async function checkedAsset(directory, source, target) {
  const filename = assetName(source.tag, target);
  const zip = join(directory, filename);
  const file = join(directory, `${filename.slice(0, -4)}.json`);
  if (!existsSync(file) || !existsSync(zip)) {
    throw new Error(`缺少 ${target} 的构建产物。`);
  }
  regularFile(file);
  const stat = regularFile(zip);
  const data = readJson(file);
  if (data.schemaVersion !== 1 || data.file !== filename || data.tag !== source.tag || data.commit !== source.commit ||
    data.target !== target || !/^[0-9a-f]{64}$/.test(data.sha256 ?? '') || await sha256(zip) !== data.sha256) {
    throw new Error(`${target} 的产物清单或 SHA-256 不匹配。`);
  }
  return { path: zip, filename, sha256: data.sha256, size: stat.size, target };
}

export function checkedTree(root) {
  const paths = new Map();
  function walk(path, prefix = '') {
    if (!lstatSync(path).isDirectory()) {
      throw new Error(`快照目录不是普通目录：${path}`);
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!/^[\w. ()+@-]+$/.test(entry.name) || /^(?:\.git|\.gitmodules|\.gitattributes)$/i.test(entry.name) ||
        /[. ]$/.test(entry.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(entry.name)) {
        throw new Error(`快照包含不安全的归档路径：${entry.name}`);
      }
      const relative = prefix + entry.name;
      if (paths.has(relative.toLowerCase())) {
        throw new Error(`快照包含大小写冲突路径：${relative}`);
      }
      paths.set(relative.toLowerCase(), relative);
      const next = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(next, `${relative}/`);
      } else if (!entry.isFile()) {
        throw new Error(`快照包含非常规文件：${relative}`);
      }
    }
  }
  walk(root);
}

export function releaseNotes(repo, source) {
  const downloads = source.targets.map((target) => {
    const name = assetName(source.tag, target);
    return `| \`${target}\` | [${name}](https://github.com/${repo}/releases/download/${source.tag}/${name}) |`;
  });
  return [
    provenance(source),
    `Upstream / 上游：[${source.tag}](${upstream}/releases/tag/${source.tag}) · [\`${source.commit}\`](${upstream}/commit/${source.commit})`,
    '', '| Platform / 平台 | Download / 下载 |', '| --- | --- |', ...downloads,
    '', `[SHA-256 checksums / 校验和](https://github.com/${repo}/releases/download/${source.tag}/SHA256SUMS)`,
    '', 'Community build. Windows ZIPs include unsigned helpers and their runtime files. Windows ARM64 is cross-built and architecture-checked, without an ARM64 runtime test. macOS ZIPs contain ad-hoc signed, non-notarized apps. No interactive desktop test was run.',
    '', '社区构建。Windows ZIP 含未签名助手及配套运行库；ARM64 交叉编译后校验二进制架构，未在 ARM64 上运行。macOS ZIP 内的应用采用临时签名，未经 Apple 公证。未执行交互式桌面测试。',
    '', 'Extract the entire ZIP. See [setup / 配置](https://github.com/' + repo + '#setup).', '',
  ].join('\n');
}

export function insistInsideOutput(path, expectedParent) {
  if (dirname(path) !== expectedParent) {
    throw new Error(`输出路径超出目录：${path}`);
  }
}
