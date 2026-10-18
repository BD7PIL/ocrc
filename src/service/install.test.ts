import { describe, expect, it } from 'vitest'
import {
  BACKUP_SUFFIX, MARKER_NAME, buildIdentityScript, buildInstallScript, buildRollbackScript,
  buildUninstallScript, decideInstall, integrityHex, parseIdentityOutput, parseInstallOutput,
} from './install.js'

const SHA = 'sha512-lCcGQCPlzrOAQ4A3ePQOieqDNfhgbUd0PS8Q2FJMRi2iaMeyiMR8XfqwZMkkby/fvcrOZTXd3bIF/b64mS2PrA=='

const OPTIONS = {
  home: '/home/demo',
  version: '2.0.27',
  integrity: SHA,
  packageName: '@opencode/cli-linux-x64',
  platform: 'linux-x64' as const,
}

describe('安装决策（D17：身份是 sha512，不是版本字符串）', () => {
  const wanted = { version: '2.0.27', integrity: SHA }

  it('没有引擎 → install', () => {
    expect(decideInstall({ marker: null }, wanted).action).toBe('install')
  })

  it('在位但不可执行（升到一半）→ reinstall', () => {
    expect(decideInstall({ version: '2.0.27', executable: false, marker: { integrity: SHA } }, wanted).action).toBe('reinstall')
  })

  it('不是我们部署的（无 marker）→ reinstall 以取得身份', () => {
    const decision = decideInstall({ version: '2.0.27', executable: true, marker: null }, wanted)
    expect(decision.action).toBe('reinstall')
    expect(decision.reason).toContain('取得身份')
  })

  it('版本变了就是升级/降级，不是「重装」', () => {
    expect(decideInstall({ version: '2.0.20', executable: true, marker: { integrity: 'sha512-old' } }, wanted).action).toBe('upgrade')
    expect(decideInstall({ version: '2.0.30', executable: true, marker: { integrity: 'sha512-old' } }, wanted).action).toBe('downgrade')
    expect(decideInstall({ version: '2.0.30', executable: true, marker: { integrity: 'sha512-old' } }, wanted).reason).toContain('面板宿主')
  })

  it('同版本同工件 → none（不重复推 200MB）', () => {
    const decision = decideInstall({ version: '2.0.27', executable: true, marker: { integrity: SHA } }, wanted)
    expect(decision.action).toBe('none')
    expect(decision.reason).toContain('工件一致')
  })

  it('同版本但 sha 变了（面板侧重发）→ reinstall——版本号看不出真假', () => {
    const decision = decideInstall({ version: '2.0.27', executable: true, marker: { integrity: 'sha512-republished' } }, wanted)
    expect(decision.action).toBe('reinstall')
    expect(decision.reason).toContain('重新发布')
  })

  it('版本字符串不同但发布号相同 → reinstall，不假装是同版', () => {
    expect(decideInstall({ version: '2.0.27+build2', executable: true, marker: { integrity: SHA } }, wanted).action).toBe('reinstall')
  })
})

describe('身份读取脚本', () => {
  it('只读 ~/.opencode/bin 与我们的 marker，不碰用户既有安装', () => {
    const script = buildIdentityScript('/home/demo')
    expect(script).toContain("D='/home/demo/.opencode/bin'")
    expect(script).toContain('.ocrc-deploy.json')
    expect(script).not.toContain('.local/bin')
  })

  it('解析真机形状的输出（含 marker 块与 CRLF）', () => {
    const stdout = [
      'PRESENT=yes',
      'EXECUTABLE=yes',
      'VERSION=opencode v2.0.27',
      `MARKER_BEGIN\r`,
      `{"integrity":"${SHA}","version":"2.0.27","package":"@opencode/cli-linux-x64","platform":"linux-x64","deployedAt":1792130631}\r`,
      'MARKER_END',
      'IDENTITY_DONE=1',
    ].join('\n')
    const identity = parseIdentityOutput(stdout)
    expect(identity.version).toBe('opencode v2.0.27')
    expect(identity.executable).toBe(true)
    expect(identity.marker?.integrity).toBe(SHA)
  })

  it('marker 坏了当作没有（按内容重装会重写它，比猜它安全）', () => {
    const identity = parseIdentityOutput(`PRESENT=yes\nEXECUTABLE=yes\nVERSION=2.0.27\nMARKER_BEGIN\n{not json\nMARKER_END\n`)
    expect(identity.marker).toBeNull()
    expect(identity.executable).toBe(true)
  })

  it('目录不存在时不给出版本', () => {
    const identity = parseIdentityOutput('PRESENT=no\nEXECUTABLE=no\nIDENTITY_DONE=1\n')
    expect(identity.version).toBeUndefined()
    expect(identity.marker).toBeNull()
  })
})

describe('安装脚本', () => {
  it('落点在 ~/.opencode/bin，旧件备份 .ocrc-bak，marker 记 sha512', () => {
    const script = buildInstallScript({ ...OPTIONS, uploadedTar: '/tmp/x/uploaded.tgz' })
    expect(script).toContain("B='/home/demo/.opencode/bin/opencode'")
    expect(script).toContain('"$B.ocrc-bak"')
    expect(script).toContain(`'/home/demo/.opencode/bin/${MARKER_NAME}'`)
    // marker 里是工件身份，不是版本字符串。
    expect(script).toContain(`"integrity":${JSON.stringify(SHA)}`)
    // 绝不覆盖用户既有安装：脚本里只有 ~/.opencode/bin 一条落点。
    expect(script).not.toContain('.local/bin')
  })

  it('推送路把上传的 tar 挪进临时目录；直取路自己下载', () => {
    const push = buildInstallScript({ ...OPTIONS, uploadedTar: '/tmp/up.tgz' })
    expect(push).toContain("mv '/tmp/up.tgz' \"$TMP/pkg.tgz\"")

    const pull = buildInstallScript({ ...OPTIONS, downloadUrl: 'https://registry.npmjs.org/@opencode/cli-linux-x64/-/x.tgz' })
    expect(pull).toContain('curl -fsSL -o "$TMP/pkg.tgz" "$URL"')
    expect(pull).toContain('wget -q -O "$TMP/pkg.tgz" "$URL"')
    expect(pull).toContain('OCRC_ERR=no-downloader')
  })

  it('两条路都过同一套校验，且没有校验工具时拒绝安装', () => {
    const script = buildInstallScript({ ...OPTIONS, uploadedTar: '/tmp/up.tgz' })
    expect(script).toContain(`EXPECT_B64='${SHA}'`)
    expect(script).toContain(`EXPECT_HEX='${integrityHex(SHA)}'`)
    expect(script).toContain('OCRC_ERR=integrity')
    expect(script).toContain('OCRC_ERR=no-checksum-tool')
  })

  it('解出来的二进制版本不对就停手（包名/变体选错了）', () => {
    const script = buildInstallScript({ ...OPTIONS, uploadedTar: '/tmp/up.tgz' })
    expect(script).toContain('OCRC_ERR=version')
    expect(script).toContain('package/bin/opencode')
  })

  it('integrityHex 与 base64 指向同一串字节', () => {
    expect(integrityHex('sha512-AAAA')).toBe('000000')
  })
})

describe('安装结果解析', () => {
  it('成功时带回路径、版本与备份位置', () => {
    const outcome = parseInstallOutput(
      ['OCRC_OK=1', 'OCRC_PATH=/home/demo/.opencode/bin/opencode', 'OCRC_VERSION=opencode v2.0.27', 'OCRC_BACKUP=/home/demo/.opencode/bin/opencode.ocrc-bak'].join('\n'),
      SHA,
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.version).toContain('2.0.27')
    expect(outcome.backup).toContain(BACKUP_SUFFIX)
  })

  it('校验失败要能和下载失败分开——用户要做的事不一样', () => {
    const integrity = parseInstallOutput(`OCRC_ERR=integrity\nOCRC_GOT=sha512-other`, SHA)
    expect(integrity.error).toContain('校验失败')
    expect(integrity.expected).toBe(SHA)
    expect(integrity.got).toBe('sha512-other')

    const download = parseInstallOutput('OCRC_ERR=download', SHA)
    expect(download.error).toContain('面板推送')
  })

  it('没有 curl/wget 时指向另一条取件路', () => {
    expect(parseInstallOutput('OCRC_ERR=no-downloader', SHA).error).toContain('推送')
  })

  it('脚本没给出结果（连接断了）也算失败，不当作成功', () => {
    expect(parseInstallOutput('', SHA).ok).toBe(false)
  })
})

describe('回滚与卸载', () => {
  it('回滚只把 .ocrc-bak 挪回去，且如实报告有没有回滚成功', () => {
    const script = buildRollbackScript('/home/demo', 'linux-x64')
    expect(script).toContain('mv "$B.ocrc-bak" "$B"')
    expect(script).toContain('OCRC_ROLLED_BACK=1')
    expect(script).toContain('OCRC_ROLLED_BACK=0')
  })

  it('卸载只删我们自己的命名空间（用户的既有安装不在其中）', () => {
    const script = buildUninstallScript('/home/demo')
    expect(script).toContain('"$D/opencode"')
    expect(script).toContain(`"$D/${MARKER_NAME}"`)
    expect(script).not.toContain('.local/bin')
    expect(script).not.toContain('rm -rf "$HOME"')
  })
})
