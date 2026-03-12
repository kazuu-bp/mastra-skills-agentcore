import { Workspace, LocalFilesystem, LocalSandbox } from '@mastra/core/workspace'

export const skillsWorkspace = new Workspace({
  filesystem: new LocalFilesystem({
    basePath: '/app/workspace',
    instructions: '生成したファイルをユーザーに渡す場合は、必ず "/app/workspace/outputs/" に保存してください。',
  }),
  sandbox: new LocalSandbox({
    workingDirectory: '/app/workspace',
  }),
  skills: ['/app/workspace/skills/**'],
})