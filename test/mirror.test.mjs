import assert from 'node:assert/strict';
import test from 'node:test';
import { assetName, batch, checkedSource, checkedTag, completeRelease, provenance, releaseNotes } from '../scripts/mirror.mjs';
import { eligibleRelease } from '../scripts/source.mjs';
import { peMachine } from '../scripts/build.mjs';

const source = {
  schemaVersion: 1,
  tag: 'dsh-v0.2.3-alpha.2',
  commit: 'a'.repeat(40),
  prerelease: true,
  targets: ['win-x64', 'darwin-arm64'],
  sources: { windows: 'packages/experimental/cua-windows/native', macos: 'packages/experimental/cua-macos/native' },
};

const file = (name) => ({ name, state: 'uploaded', size: 10, digest: `sha256:${'b'.repeat(64)}` });

test('只接受可安全用作路径和 Git 标签的上游版本', () => {
  assert.equal(checkedTag(source.tag), source.tag);
  assert.equal(checkedTag('dsh-v0.3.0'), 'dsh-v0.3.0');
  for (const value of ['dsh-v1.0.0-03', 'dsh-v01.2.3', 'dsh-v1.2.3+build', '../dsh-v1.2.3', 'dsh-v1.2.3\n', '--help']) {
    assert.throws(() => checkedTag(value));
  }
});

test('自动同步包含起始预发布、同核心版本正式版和更晚版本', () => {
  const baseline = { tag_name: source.tag, draft: false, prerelease: true, published_at: '2026-11-22T11:00:39Z' };
  assert.equal(eligibleRelease(baseline), true);
  assert.equal(eligibleRelease({ ...baseline, tag_name: 'dsh-v0.2.3', published_at: '2026-11-23T00:00:00Z' }), true);
  assert.equal(eligibleRelease({ ...baseline, tag_name: 'native-v0.2.3' }), false);
  assert.equal(eligibleRelease({ ...baseline, draft: true }), false);
  assert.equal(eligibleRelease({ ...baseline, published_at: '2026-11-22T11:00:38Z' }), false);
});

test('分批处理会轮到剩余标签', () => {
  const items = Array.from({ length: 19 }, (_, index) => `tag-${index}`);
  assert.deepEqual([...batch(items, 0), ...batch(items, 1), ...batch(items, 2)], items);
  assert.deepEqual(batch(items, 3), items.slice(0, 8));
});

test('拒绝错误来源和重复目标，接受只有一个平台的清单', () => {
  assert.equal(checkedSource(source, source), source);
  assert.throws(() => checkedSource({ ...source, commit: 'b'.repeat(40) }, source));
  assert.throws(() => checkedSource({ ...source, targets: ['win-x64', 'win-x64'] }, source));
  assert.doesNotThrow(() => checkedSource({ ...source, targets: ['win-x64'] }, source));
});

test('只有匹配上游版本且资产齐全的已公开 Release 可以跳过重建', () => {
  const release = { tag_name: source.tag, draft: false, prerelease: true, body: provenance(source), assets: [...source.targets.map((target) => file(assetName(source.tag, target))), file('SHA256SUMS')] };
  assert.equal(completeRelease(release, source), true);
  assert.equal(completeRelease({ ...release, draft: true }, source), false);
  assert.equal(completeRelease({ ...release, assets: release.assets.slice(0, 2) }, source), false);
  assert.equal(completeRelease(release, { ...source, commit: 'b'.repeat(40) }), false);
  const notes = releaseNotes('dsh-plugins/dsh-cua-helper', source);
  for (const item of release.assets) {
    assert.ok(notes.includes(`/releases/download/${source.tag}/${item.name})`));
  }
});

test('PE 架构解析检查边界和机器类型', () => {
  assert.throws(() => peMachine(Buffer.alloc(10)));
  const binary = Buffer.alloc(70);
  binary.writeUInt16LE(0x5a4d);
  binary.writeUInt32LE(64, 60);
  binary.writeUInt32LE(0x4550, 64);
  binary.writeUInt16LE(0xaa64, 68);
  assert.equal(peMachine(binary), 0xaa64);
  binary.writeUInt32LE(200, 60);
  assert.throws(() => peMachine(binary));
});
