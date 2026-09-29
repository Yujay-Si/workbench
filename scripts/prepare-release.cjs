const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const config = require(path.join(root, 'package.json'));
const { version } = config;
const { owner, repo } = config.build.publish;
const dist = path.join(root, 'dist');
const portableName = `NEXUS-Workbench-${version}-win-x64.exe`;
const setupName = `NEXUS-Workbench-Setup-${version}-win-x64.exe`;
const portablePath = path.join(dist, portableName);
const setupPath = path.join(dist, setupName);
const updateInfoPath = path.join(dist, 'latest.yml');

if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`Git 标签 ${process.env.GITHUB_REF_NAME} 与 package.json 版本 ${version} 不一致`);
}
for (const file of [portablePath, setupPath, updateInfoPath]) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`缺少发布文件：${path.basename(file)}`);
  }
}
const updateInfo = fs.readFileSync(updateInfoPath, 'utf8');
if (!updateInfo.includes(`version: ${version}`) || !updateInfo.includes(setupName)) {
  throw new Error('latest.yml 与当前安装包版本不匹配');
}

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(portablePath)).digest('hex');
const manifest = {
  version,
  downloadUrl: `https://github.com/${owner}/${repo}/releases/download/v${version}/${portableName}`,
  sha256
};
const output = path.join(dist, 'latest.json');
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`已准备 ${path.basename(output)}：v${version}`);
