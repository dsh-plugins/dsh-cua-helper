import { cpSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkedAsset, checkedSource, checkedTag, checkedTree, command, completeRelease, git, provenance, readJson, releaseMap, releaseNotes, repository, sha256, sourceAt } from './mirror.mjs';

const repo = repository();
const pending = resolve(process.argv[2] ?? 'pending');
const binaries = resolve(process.argv[3] ?? 'binaries');
const staging = resolve(process.argv[4] ?? 'release-staging');
const main = 'refs/remotes/origin/main';
const { versions, errors } = readJson(join(pending, 'plans.json'));
const releases = await releaseMap(repo);
const runnerScriptEnabled = process.env.GITHUB_REF === 'refs/heads/main' &&
  ['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME);
if (!runnerScriptEnabled || process.env.GH_TOKEN === undefined) {
  throw new Error('发布仅允许在默认分支的定时或手动任务中执行。');
}

function gh(args) {
  return command('gh', args);
}

function syncMain() {
  git(['fetch', '--no-tags', 'origin', `refs/heads/main:${main}`]);
  git(['reset', '--hard', main]);
}

function remoteRef(tag) {
  return git(['ls-remote', 'origin', `refs/tags/${tag}`]);
}

function checkedTagTree(source) {
  const ref = `refs/tags/${source.tag}`;
  git(['fetch', '--no-tags', 'origin', ref]);
  checkedSource(sourceAt('FETCH_HEAD', source.tag), source);
  const paths = `versions/${source.tag}`;
  const tagTree = git(['rev-parse', `FETCH_HEAD:${paths}`]);
  if (tagTree !== git(['rev-parse', `HEAD:${paths}`])) {
    throw new Error('同名镜像标签指向不同的源码目录。');
  }
}

function syncSource(source, directory) {
  syncMain();
  if (!sourceAt('HEAD', source.tag)) {
    const destination = join('versions', source.tag);
    mkdirSync('versions', { recursive: true });
    cpSync(directory, destination, { recursive: true, errorOnExist: true, force: false });
    git(['add', '-f', '--', destination]);
    git(['commit', '-m', `chore(sync): 同步 ${source.tag} 的原生助手源码`]);
  } else {
    checkedSource(sourceAt('HEAD', source.tag), source);
  }
  if (!source.targets.length) {
    git(['push', 'origin', 'HEAD:refs/heads/main']);
    return;
  }
  if (remoteRef(source.tag)) {
    checkedTagTree(source);
    return;
  }
  git(['push', '--atomic', 'origin', 'HEAD:refs/heads/main', `HEAD:refs/tags/${source.tag}`]);
}

function api(method, path, fields = []) {
  return JSON.parse(gh(['api', '--method', method, `repos/${repo}/${path}`, ...fields]));
}

async function upload(id, asset) {
  const response = await fetch(`https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(asset.filename)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(asset.size),
      'User-Agent': 'dsh-cua-helper',
    },
    body: createReadStream(asset.path),
    duplex: 'half',
    redirect: 'error',
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    throw new Error(`上传 ${asset.filename} 失败：HTTP ${response.status} ${await response.text()}`);
  }
  const uploaded = await response.json();
  if (uploaded.name !== asset.filename || uploaded.state !== 'uploaded' || uploaded.size !== asset.size || uploaded.digest !== `sha256:${asset.sha256}`) {
    throw new Error(`上传后的 ${asset.filename} 未通过摘要校验。`);
  }
}

function verifyRemoteAssets(id, assets) {
  const remote = api('GET', `releases/${id}/assets?per_page=100`);
  for (const expected of assets) {
    if (!remote.some((item) => item.name === expected.filename && item.state === 'uploaded' && item.size === expected.size &&
      item.digest === `sha256:${expected.sha256}`)) {
      throw new Error(`远程 Release 的 ${expected.filename} 未通过校验。`);
    }
  }
}

async function publish(plan) {
  const directory = join(pending, 'versions', checkedTag(plan.tag));
  checkedTree(directory);
  const source = checkedSource(readJson(join(directory, 'source.json')), plan);
  let release = releases.get(source.tag);
  if (release && (!release.body?.includes(provenance(source)) || release.prerelease !== source.prerelease)) {
    throw new Error('同名 Release 的来源或预发布状态与上游不一致。');
  }
  if (completeRelease(release, source)) {
    return;
  }
  if (release && !release.draft) {
    throw new Error('已公开 Release 不可改写。');
  }
  const assets = [];
  for (const target of source.targets) {
    assets.push(await checkedAsset(join(binaries, `binary-${source.tag}-${target}`), source, target));
  }
  syncSource(source, directory);
  if (!assets.length) {
    console.log(`${source.tag} 没有可构建的原生助手，已记录源码状态，不创建空 Release。`);
    return;
  }
  const output = join(staging, source.tag);
  mkdirSync(output, { recursive: true });
  const sums = join(output, 'SHA256SUMS');
  const contents = assets.map((asset) => `${asset.sha256}  ${asset.filename}`).join('\n') + '\n';
  writeFileSync(sums, contents);
  assets.push({ path: sums, filename: 'SHA256SUMS', size: Buffer.byteLength(contents), sha256: await sha256(sums) });
  const notes = join(output, 'notes.md');
  writeFileSync(notes, releaseNotes(repo, source));
  if (!release) {
    release = api('POST', 'releases', ['-f', `tag_name=${source.tag}`, '-f', `name=${source.tag}`, '-F', `body=@${notes}`,
      '-F', 'draft=true', '-F', `prerelease=${source.prerelease}`]);
  }
  if (!Number.isSafeInteger(release?.id) || !release.draft || release.tag_name !== source.tag || !release.body?.includes(provenance(source))) {
    throw new Error('未找到本工作流创建的草稿 Release。');
  }
  const previousAssets = api('GET', `releases/${release.id}/assets?per_page=100`);
  for (const asset of assets) {
    const existing = previousAssets.find((item) => item.name === asset.filename);
    if (existing?.state === 'uploaded' && existing.digest === `sha256:${asset.sha256}` && existing.size === asset.size) {
      continue;
    }
    if (existing) {
      gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${existing.id}`]);
    }
    await upload(release.id, asset);
  }
  verifyRemoteAssets(release.id, assets);
  const published = api('PATCH', `releases/${release.id}`, ['-F', 'draft=false', '-F', `body=@${notes}`,
    ...(source.prerelease ? ['-f', 'make_latest=false'] : [])]);
  if (!completeRelease(published, source)) {
    throw new Error('Release 公开后未通过完整性检查。');
  }
  console.log(`${source.tag}: ${published.html_url}`);
}

for (const plan of versions) {
  try {
    await publish(plan);
  } catch (error) {
    errors.push({ tag: plan.tag, message: error.message });
  }
}
for (const { tag, message } of errors) {
  console.error(`${tag}: ${message}`);
}
if (errors.length) {
  process.exitCode = 1;
}
