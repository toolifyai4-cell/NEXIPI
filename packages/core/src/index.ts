export { version } from './version.js';

export interface AgentConfig {
  readonly name: string;
  readonly version: string;
}

export const defaultConfig: AgentConfig = {
  name: 'nexipi',
  version: '0.0.1',
};
