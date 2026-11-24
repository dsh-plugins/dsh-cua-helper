import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assetName, checkedSource, checkedTree, command, readJson, regularFile, sha256 } from './mirror.mjs';

function run(program, args, cwd) {
  console.log(`${program} ${args.join(' ')}`);
  command(program, args, { cwd, stdio: 'inherit' });
}

export function peMachine(data) {
  if (data.length < 64 || data.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('缺少 PE 文件的 DOS 标头。');
  }
  const offset = data.readUInt32LE(60);
  if (offset < 64 || data.length < offset + 6 || data.readUInt32LE(offset) !== 0x4550) {
    throw new Error('缺少有效的 PE 文件标头。');
  }
  return data.readUInt16LE(offset + 4);
}

function copyWindowsNotices(runtime, project, payload) {
  const notices = join(payload, 'licenses');
  mkdirSync(notices);
  const resolved = readJson(join(runtime, 'obj', 'project.assets.json'));
  const graph = readJson(join(payload, 'dsh-cua-windows.deps.json'));
  const packages = Object.entries(graph.libraries).filter(([, library]) => library.type === 'package');
  const index = [];
  const foundRuntimeNotice = new Set();
  const lookup = (relative) => Object.keys(resolved.packageFolders).map((folder) => join(folder, relative)).find(existsSync);
  for (const [id, library] of packages) {
    const relative = library.path ?? id.toLowerCase();
    const restored = lookup(relative);
    if (!restored) {
      throw new Error(`未找到已还原的依赖 ${id}。`);
    }
    const directory = join(notices, id.replace('/', '-'));
    mkdirSync(directory);
    for (const file of readdirSync(restored, { withFileTypes: true })) {
      if (file.isFile() && /^(?:license|licence|copying|notice|third[-_. ]?party|.*\.nuspec)/i.test(file.name)) {
        copyFileSync(join(restored, file.name), join(directory, file.name));
      }
    }
    index.push(`- ${id}: https://www.nuget.org/packages/${id}`);
  }
  for (const download of Object.values(resolved.project.frameworks).flatMap((framework) => framework.downloadDependencies ?? [])) {
    if (!/^Microsoft\.NETCore\.App\.Runtime\.|^Microsoft\.WindowsDesktop\.App\.Runtime\./i.test(download.name)) {
      continue;
    }
    const version = /^\[([^,\]]+)\]$/.exec(download.version)?.[1];
    const restored = lookup(`${download.name.toLowerCase()}/${version}`);
    if (!restored) {
      throw new Error(`未找到 .NET 运行库的授权文件来源：${download.name} ${version}。`);
    }
    const directory = join(notices, `${download.name}-${version}`);
    mkdirSync(directory);
    const legalFiles = readdirSync(restored).filter((name) => /^(?:license|third[-_. ]?party|notice)/i.test(name));
    for (const name of legalFiles) {
      copyFileSync(join(restored, name), join(directory, name));
    }
    if (legalFiles.length) {
      foundRuntimeNotice.add(download.name);
    }
  }
  for (const dir of Object.keys(resolved.packageFolders)) {
    for (const id of ['microsoft.netcore.app.runtime.' + project, 'microsoft.windowsdesktop.app.runtime.' + project]) {
      if ([...foundRuntimeNotice].some((name) => name.toLowerCase() === id) || !existsSync(join(dir, id))) {
        continue;
      }
      for (const version of readdirSync(join(dir, id))) {
        const restored = join(dir, id, version);
        const legalFiles = readdirSync(restored).filter((name) => /^(?:license|third[-_. ]?party|notice)/i.test(name));
        if (legalFiles.length) {
          const directory = join(notices, `${id}-${version}`);
          mkdirSync(directory, { recursive: true });
          for (const name of legalFiles) {
            copyFileSync(join(restored, name), join(directory, name));
          }
          foundRuntimeNotice.add(id);
        }
      }
    }
  }
  if (foundRuntimeNotice.size < 2) {
    throw new Error('缺少 .NET Core 或 Windows Desktop 运行库的许可证及第三方声明。');
  }
  writeFileSync(join(notices, 'NuGet-packages.md'), '# Included NuGet packages\n\n' + index.join('\n') + '\n');
}

function windows(native, target, payload) {
  const entry = join(native, 'entry', 'CuaWindows.csproj');
  const protocolTest = join(native, 'tests', 'Protocol.Tests.csproj');
  const restore = ['restore', '--locked-mode', '-p:EnableWindowsTargeting=true'];
  run('dotnet', [...restore, join(native, 'cua-windows.slnx')], native);
  if (target === 'win-x64') {
    run('dotnet', ['run', '--project', protocolTest, '--configuration', 'Release', '--no-restore'], native);
  }
  run('dotnet', ['publish', entry, '--configuration', 'Release', '--runtime', target, '--self-contained', 'true', '--no-restore', '--output', payload, '-p:EnableWindowsTargeting=true'], native);
  const executable = join(payload, 'dsh-cua-windows.exe');
  for (const name of ['dsh-cua-windows.exe', 'dsh-cua-windows.dll', 'dsh-cua-windows.deps.json', 'dsh-cua-windows.runtimeconfig.json', 'CuaProtocol.dll', 'coreclr.dll', 'hostfxr.dll']) {
    regularFile(join(payload, name));
  }
  if (peMachine(readFileSync(executable)) !== (target === 'win-x64' ? 0x8664 : 0xaa64)) {
    throw new Error(`打包后的 exe 架构与 ${target} 不匹配。`);
  }
  copyWindowsNotices(join(native, 'entry'), target, payload);
}

function macos(native, target, scratch, payload) {
  const arch = target === 'darwin-x64' ? 'x86_64' : 'arm64';
  const out = join(scratch, 'package');
  run('/usr/bin/xcrun', ['python3', join(native, 'build_app.py'), '--arch', arch, '--scratch-path', join(scratch, 'swift'), '--output-directory', out, '--variant', 'dev', '--identity', '-'], native);
  const { bundle } = readJson(join(out, 'current.json'));
  if (typeof bundle !== 'string' || !/^[0-9a-f]{64}$/.test(bundle)) {
    throw new Error('无效的 macOS 应用生成目录。');
  }
  const application = 'DSH Computer Use Dev.app';
  run('/usr/bin/ditto', [join(out, bundle, application), join(payload, application)], native);
  const installed = join(payload, application);
  const slices = command('/usr/bin/lipo', ['-archs', join(installed, 'Contents', 'MacOS', 'dsh-cua-native')]);
  if (slices !== arch) {
    throw new Error(`打包后的 Mach-O 架构 ${slices} 与 ${arch} 不匹配。`);
  }
  run('/usr/bin/codesign', ['--verify', '--strict', '--deep', installed], native);
  if (process.arch === (arch === 'x86_64' ? 'x64' : arch)) {
    const tests = join(native, 'tests', 'test_swift.py');
    if (existsSync(tests)) {
      run('/usr/bin/xcrun', ['python3', tests, '--scratch-path', join(scratch, 'swift-test')], native);
    } else {
      run('/usr/bin/xcrun', ['swift', 'test', '--package-path', native, '--scratch-path', join(scratch, 'swift-test')], native);
    }
  }
}

async function build(args) {
  if (args.length !== 3) {
    throw new Error('用法：node scripts/build.mjs <源码快照> <目标> <输出目录>');
  }
  const [snapshot, target, destination] = args;
  const output = resolve(destination);
  const source = readJson(join(snapshot, 'source.json'));
  checkedSource(source, source);
  const filename = assetName(source.tag, target);
  const onWindows = target.startsWith('win-');
  if (!source.targets.includes(target) || process.platform !== (onWindows ? 'win32' : 'darwin')) {
    throw new Error(`当前快照或主机不支持目标 ${target}。`);
  }
  const platform = onWindows ? 'windows' : 'macos';
  const relative = source.sources[platform];
  if (!/^packages\/experimental\/[a-z-]+\/native$/.test(relative ?? '')) {
    throw new Error(`无效的 ${platform} 源码路径。`);
  }
  if (existsSync(output) && readdirSync(output).length) {
    throw new Error(`输出目录必须为空：${output}`);
  }
  regularFile(join(snapshot, 'LICENSE'));
  const native = join(snapshot, relative);
  checkedTree(native);
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-cua-native-'));
  try {
    const copy = join(scratch, 'native');
    const payload = join(scratch, 'payload');
    cpSync(native, copy, { recursive: true });
    mkdirSync(payload);
    copyFileSync(join(snapshot, 'LICENSE'), join(payload, 'LICENSE'));
    for (const entry of readdirSync(native, { withFileTypes: true })) {
      if (entry.isFile() && /^(?:license|notice|third[-_. ]?party)/i.test(entry.name) && entry.name !== 'LICENSE') {
        copyFileSync(join(native, entry.name), join(payload, entry.name));
      }
    }
    if (onWindows) {
      windows(copy, target, payload);
    } else {
      macos(copy, target, scratch, payload);
    }
    const zip = join(scratch, filename);
    if (onWindows) {
      run('tar.exe', ['-a', '-cf', zip, '-C', payload, '.'], scratch);
      const listing = command('tar.exe', ['-tf', zip]);
      if (!/^\.\/dsh-cua-windows\.exe\r?$/m.test(listing)) {
        throw new Error('ZIP 根目录缺少 Windows 助手。');
      }
    } else {
      run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', payload, zip], scratch);
      const extracted = join(scratch, 'archive-check');
      run('/usr/bin/ditto', ['-x', '-k', zip, extracted], scratch);
      run('/usr/bin/codesign', ['--verify', '--strict', '--deep', join(extracted, 'DSH Computer Use Dev.app')], scratch);
    }
    const sha = await sha256(zip);
    mkdirSync(output, { recursive: true });
    copyFileSync(zip, join(output, filename));
    writeFileSync(join(output, `${basename(filename, '.zip')}.json`), JSON.stringify({ schemaVersion: 1, tag: source.tag, commit: source.commit, target, sha256: sha, file: filename }, null, 2) + '\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (import.meta.main) {
  await build(process.argv.slice(2));
}
