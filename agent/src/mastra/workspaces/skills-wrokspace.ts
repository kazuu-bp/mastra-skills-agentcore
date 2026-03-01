import { Workspace, LocalFilesystem, LocalSandbox } from '@mastra/core/workspace'

export const skillsWorkspace = new Workspace({
  filesystem: new LocalFilesystem({
    basePath: './workspace',
    instructions: '生成したファイルを出力する場合は、必ず "/outputs/" ディレクトリに保存してください。',
  }),
  sandbox: new LocalSandbox({
    workingDirectory: './workspace',
  }),
  skills: ['/skills'],
})