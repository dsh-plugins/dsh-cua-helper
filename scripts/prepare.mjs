import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { batch, checkedSource, completeRelease, git, provenance, releaseMap, repository, runners, sourceAt } from './mirror.mjs';
import { discover, snapshot } from './source.mjs';

const repo = repository();
const root = resolve(process.argv[2] ?? 'pending');
const manualTag = process.env.UPSTREAM_TAG || undefined;
const discovered = await discover({ manualTag, token: process.env.GH_TOKEN, repository: repo });
const downstream = await releaseMap(repo);
git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);

const pending = [];
const errors = [];
for (const plan of discovered) {
  try {
    const existing = sourceAt('refs/remotes/origin/main', plan.tag);
    const release = downstream.get(plan.tag);
    if (existing) {
      checkedSource(existing, plan);
    }
    if (release && (!existing || !release.body?.includes(provenance(plan)))) {
      throw new Error('镜像已有不同来源的同名 Release。');
    }
    if (existing && (existing.targets.length === 0 || completeRelease(release, existing))) {
      console.log(`${plan.tag} 已处理。`);
      continue;
    }
    if (release && !release.draft) {
      throw new Error('已公开 Release 的资产不完整，需要人工处理；自动化不会覆盖它。');
    }
    pending.push(plan);
  } catch (error) {
    errors.push({ tag: plan.tag, message: error.message });
  }
}

mkdirSync(join(root, 'versions'), { recursive: true });
const matrix = [];
const versions = [];
for (const plan of batch(pending, Math.floor(Date.now() / 3600000))) {
  console.log(`正在准备 ${plan.tag} (${plan.commit})。`);
  try {
    const source = checkedSource(await snapshot(plan, join(root, 'versions', plan.tag)), plan);
    versions.push(plan);
    for (const target of source.targets) {
      matrix.push({ tag: plan.tag, target, runner: runners[target] });
    }
  } catch (error) {
    errors.push({ tag: plan.tag, message: error.message });
  }
}

for (const { tag, message } of errors) {
  console.error(`${tag}: ${message}`);
}
writeFileSync(join(root, 'plans.json'), JSON.stringify({ versions, errors }, null, 2) + '\n');
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: matrix })}\ncount=${matrix.length}\npending=${versions.length + errors.length}\n`);
}
console.log(`本轮准备 ${versions.length} 个版本，${matrix.length} 项构建，${errors.length} 项错误；待处理共 ${pending.length} 个版本。`);
