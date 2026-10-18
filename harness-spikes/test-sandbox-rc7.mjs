import { Context } from '@deepseek-ai/cordis'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
const ctx = new Context()
await ctx.plugin(LocalSandboxProvider)
ctx.sandbox.internals.landlockLauncher = '<dsh>/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run'
const c = ctx.sandbox.confine(['python3','-c','print(1+1)'], {mode:'workspace-write', workspaceRoot: process.cwd()})
console.log('enforcement', c.enforcement, 'argv0', c.argv[0])
