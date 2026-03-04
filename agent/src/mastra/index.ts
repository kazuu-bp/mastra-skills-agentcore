
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';

import { skillsAgent } from './agents/skills-agent.js';

export const mastra = new Mastra({
  workflows: {},
  agents: { skillsAgent },

  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});