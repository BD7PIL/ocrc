// zcode-services/webAttachments.ts — web 端附件的字节寄存（N7-1）。
//
// 两条入口，同一个寄存表：
//  1. platform 选图/拖图 → getPathForFile 返回 `ocrc-webfile://<id>` 句柄（composer 的
//     本地零拷贝链路把它原样放进 sendText.attachments[].ref，不触发 V4 上传）；
//  2. V4 上传（attachmentBeginV4/ChunkV4/CommitV4）→ commit 后以 `ocrc-att://<uploadId>`
//     入表。
// 发送时 zcodeAgentService 用 resolveWebFile 取回字节，转成 /api/message 的 images[]。
// 寄存表随页面生命周期存在——发送成功前必须有效。

const store = new Map<string, Blob>()
let seq = 0

export const WEBFILE_SCHEME = 'ocrc-webfile://'
export const ATTACHMENT_SCHEME = 'ocrc-att://'

export function putWebFile(file: File): string {
  seq += 1
  const handle = `${WEBFILE_SCHEME}${Date.now().toString(36)}-${seq}-${file.name.replace(/[^\w.-]+/g, '_')}`
  store.set(handle, file)
  return handle
}

export function putAttachmentBlob(id: string, blob: Blob): string {
  const ref = `${ATTACHMENT_SCHEME}${id}`
  store.set(ref, blob)
  return ref
}

export function takeAttachmentBytes(id: string): Blob | undefined {
  return store.get(`${ATTACHMENT_SCHEME}${id}`)
}

export function dropAttachmentBytes(id: string): void {
  store.delete(`${ATTACHMENT_SCHEME}${id}`)
}

export function resolveWebFile(ref: string): Blob | undefined {
  return store.get(ref)
}

/** 发送完成后即可释放（引擎已收到字节）；失败保留以便重试。 */
export function releaseWebFile(ref: string): void {
  store.delete(ref)
}

export function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(blob)
  })
}
