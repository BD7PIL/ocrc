// P0-1 probe plugin A: registers the tool `wf_echo`.
// Loaded from a scratch HOME's ~/.config/opencode/plugin/ so it is discovered by
// every app instance (workspace) that the serve process boots.
import { appendFileSync } from 'node:fs'

const LOG = process.env.PROBE_LOG ?? '/tmp/ocrc-p0/probe-loads.log'
function note(msg) {
  try {
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), pid: process.pid, cwd: process.cwd(), msg }) + '\n')
  } catch { /* best effort */ }
}

export const ProbePlugin = async () => {
  note('probe-init')
  return {
    tool: {
      wf_echo: {
        description: 'P0-1 probe echo tool (probe A)',
        args: { value: { type: 'string', description: 'value to echo' } },
        async execute(args) {
          note('probeA wf_echo called ' + JSON.stringify(args))
          return 'probeA:' + (args?.value ?? '')
        },
      },
    },
  }
}

export default { id: 'probe', server: ProbePlugin }
