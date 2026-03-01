import { Workspace, LocalFilesystem, LocalSandbox } from '@mastra/core/workspace'

export const skillsWorkspace = new Workspace({
  filesystem: new LocalFilesystem({
    basePath: './workspace',
  }),
  sandbox: new LocalSandbox({
    workingDirectory: './workspace',
  }),
  skills: ['/skills'],
})