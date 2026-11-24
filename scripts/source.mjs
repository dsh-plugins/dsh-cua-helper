import { spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { checkedCommit as validateCommit, checkedTag as validateTag, checkedTree, git } from './mirror.mjs';

export { validateTag, validateCommit };
export const UPSTREAM_REPOSITORY = 'deepseek-ai/deepseek-harness';
const BASELINE_TIME = '2026-11-22T11:00:39Z';
const SOURCE_PATHS = Object.freeze({
  windows: 'packages/experimental/cua-windows/native',
  macos: 'packages/experimental/cua-macos/native',
});
const TARGETS = Object.freeze({ windows: ['win-x64', 'win-arm64'], macos: ['darwin-arm64', 'darwin-x64'] });

function apiHeaders(token) {
  return { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-cua-helper', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function api(url, token) {
  const response = await fetch(url, { headers: apiHeaders(token), signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}：${url}`);
  }
  return response.json();
}

async function resolveCommit(tag, token) {
  const ref = await api(`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`, token);
  let object = ref.object;
  if (object?.type === 'tag') {
    object = await api(`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/git/tags/${object.sha}`, token).then((tagObject) => tagObject.object);
  }
  return validateCommit(object?.sha);
}

export function eligibleRelease(release) {
  if (release.draft || typeof release.published_at !== 'string' || release.published_at < BASELINE_TIME) {
    return false;
  }
  try {
    validateTag(release.tag_name);
    return true;
  } catch {
    return false;
  }
}

export async function discover({ manualTag, token = process.env.GH_TOKEN } = {}) {
  if (manualTag) {
    const tag = validateTag(manualTag);
    const release = await api(`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`, token);
    if (release.draft || release.tag_name !== tag || !release.published_at) {
      throw new Error(`上游标签 ${tag} 没有可用的已发布 Release。`);
    }
    return [{ tag, commit: await resolveCommit(tag, token), prerelease: Boolean(release.prerelease), publishedAt: release.published_at }];
  }
  const plans = [];
  for (let page = 1; ; page++) {
    const releases = await api(`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases?per_page=100&page=${page}`, token);
    for (const release of releases) {
      if (!eligibleRelease(release)) {
        continue;
      }
      plans.push({ tag: validateTag(release.tag_name), commit: await resolveCommit(release.tag_name, token), prerelease: Boolean(release.prerelease), publishedAt: release.published_at });
    }
    if (releases.length < 100) {
      break;
    }
  }
  const unique = new Map(plans.map((plan) => [plan.tag, plan]));
  return [...unique.values()].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt));
}

function run(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} 失败：${result.status ?? result.signal}`);
  }
}

function copySafe(from, to) {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) {
    throw new Error(`上游源码包含符号链接：${from}`);
  }
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      copySafe(join(from, entry), join(to, entry));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`上游源码包含非常规文件：${from}`);
  }
  cpSync(from, to);
}

function assertRelativePath(value) {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`快照路径不安全：${value}`);
  }
  return normalized;
}

export async function snapshot(plan, outputDirectory) {
  validateTag(plan.tag);
  validateCommit(plan.commit);
  if (typeof plan.prerelease !== 'boolean') {
    throw new Error('上游计划的 prerelease 必须是布尔值。');
  }
  const output = resolve(outputDirectory);
  const checkout = await mkdtemp(join(tmpdir(), 'dsh-cua-source-'));
  try {
    run('git', ['-c', 'core.autocrlf=false', '-c', 'core.symlinks=true', 'clone', '--no-checkout', '--depth', '1', '--branch', plan.tag, `https://github.com/${UPSTREAM_REPOSITORY}.git`, checkout]);
    const actual = git(['rev-parse', 'HEAD'], checkout);
    if (actual !== plan.commit) {
      throw new Error(`标签 ${plan.tag} 当前解析为 ${actual}，预期 ${plan.commit}。`);
    }
    for (const item of git(['ls-tree', '-rz', 'HEAD', '--', 'LICENSE', ...Object.values(SOURCE_PATHS)], checkout).split('\0').filter(Boolean)) {
      if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(item)) {
        throw new Error('上游快照包含符号链接或 Git 子模块。');
      }
    }
    run('git', ['-c', 'core.autocrlf=false', 'sparse-checkout', 'set', '--no-cone', '/LICENSE', ...Object.values(SOURCE_PATHS).map((path) => `/${path}/`)], checkout);
    run('git', ['-c', 'core.autocrlf=false', 'checkout', '--detach', plan.commit], checkout);
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(output);
    const sources = {};
    const targets = [];
    for (const [platform, sourcePath] of Object.entries(SOURCE_PATHS)) {
      const source = join(checkout, sourcePath);
      try {
        lstatSync(source);
      } catch {
        continue;
      }
      const destination = join(output, sourcePath);
      copySafe(source, destination);
      sources[platform] = assertRelativePath(sourcePath);
      targets.push(...TARGETS[platform]);
    }
    if (!targets.length) {
      throw new Error(`标签 ${plan.tag} 没有可识别的 Computer Use 原生源码。`);
    }
    copySafe(join(checkout, 'LICENSE'), join(output, 'LICENSE'));
    const manifest = { schemaVersion: 1, tag: plan.tag, commit: plan.commit, prerelease: plan.prerelease, publishedAt: plan.publishedAt, targets, sources };
    writeFileSync(join(output, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'discover') {
    process.stdout.write(JSON.stringify(await discover({ manualTag: process.env.UPSTREAM_TAG }), null, 2) + '\n');
  } else if (command === 'snapshot' && args.length === 4) {
    const [tag, commit, prerelease, output] = args;
    if (prerelease !== 'true' && prerelease !== 'false') {
      throw new Error('snapshot 的 prerelease 必须是 true 或 false。');
    }
    const manifest = await snapshot({ tag: validateTag(tag), commit: validateCommit(commit), prerelease: prerelease === 'true', publishedAt: new Date().toISOString() }, output);
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  } else {
    throw new Error('用法：node scripts/source.mjs discover 或 node scripts/source.mjs snapshot <tag> <commit> <true|false> <output>');
  }
}
