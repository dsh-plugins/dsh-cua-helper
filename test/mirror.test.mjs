import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assetName, batch, checkedSource, checkedTag, completeRelease, provenance, releaseNotes } from '../scripts/mirror.mjs';
import { eligibleRelease } from '../scripts/source.mjs';
import { applySwiftCompatibility, peMachine } from '../scripts/build.mjs';

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

test('Swift 兼容修复转换临时源码并拒绝重复标记', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cua-swift-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'Sources', 'CuaNative');
  const testDirectory = join(root, 'tests', 'swift');
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(testDirectory, { recursive: true });
  const access = join(sourceDirectory, 'AXAccess.swift');
  const worker = join(sourceDirectory, 'AXWorker.swift');
  const sharedTests = join(testDirectory, 'SharedHelperTests.swift');
  const marker = '    func coordinateWindow(_ identity: ProcessIdentity,';
  const call = 'WindowGeometry.resolve(owner: identity, windowID: enclosing.id) { try ax().bounds(enclosing.element) }';
  const assertion = '    #expect(lstat(try #require(options.failurePath), &info) == 0)';
  const writeOriginal = () => {
    writeFileSync(access, `${marker}\n`);
    writeFileSync(worker, `window = try ${call}\n`);
    writeFileSync(sharedTests, `${assertion}\n`);
  };
  writeOriginal();

  applySwiftCompatibility(root);

  assert.equal(readFileSync(access, 'utf8'), [
    '    func geometryOfEnclosingWindow(_ identity: ProcessIdentity, _ id: UInt32, element: AXUIElement) throws -> WindowInfo {',
    '        try WindowGeometry.resolve(owner: identity, windowID: id) { try self.bounds(element) }',
    '    }',
    marker,
    '',
  ].join('\n'));
  assert.equal(readFileSync(worker, 'utf8'), 'window = try ax().geometryOfEnclosingWindow(identity, enclosing.id, element: enclosing.element)\n');
  assert.equal(readFileSync(sharedTests, 'utf8'), [
    '    let failurePath: String = try #require(options.failurePath)',
    '    let failureStat = lstat(failurePath, &info)',
    '    #expect(failureStat == 0)',
    '',
  ].join('\n'));

  writeOriginal();
  writeFileSync(access, `${marker}\n${marker}\n`);
  assert.throws(() => applySwiftCompatibility(root), /Swift 兼容修复与原始源码不匹配/);
});
