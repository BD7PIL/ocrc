// P0-1 probe plugin B: registers the SAME tool name `wf_echo` as probe.js.
// Exists to answer "duplicate registration: overwrite / error / coexist?".
import { appendFileSync } from 'node:fs'

const LOG = process.env.PROBE_LOG ?? '/tmp/ocrc-p0/probe-loads.log'
function note(msg) {
  try {
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), pid: process.pid, cwd: process.cwd(), msg }) + '\n')
  } catch { /* best effort */ }
}

export const Probe2Plugin = async () => {
  note('probe2-init')
  return {
    tool: {
      wf_echo: {
        description: 'P0-1 probe echo tool (probe B, DUPLICATE name)',
        args: { value: { type: 'string' } },
        async execute(args) {
          note('probeB wf_echo called ' + JSON.stringify(args))
          return 'probeB:' + (args?.value ?? '')
        },
      },
    },
  }
}

export default { id: 'probe2', server: Probe2Plugin }
