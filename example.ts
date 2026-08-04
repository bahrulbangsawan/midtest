import { agentForComputer, checkComputerEnvironment } from '@midscene/computer';

const env = await checkComputerEnvironment();
console.log('Environment check:', env);

const agent = await agentForComputer({
  aiActionContext: 'You are controlling a macOS desktop computer.',
});

const screenInfo = await agent.aiQuery(
  '{width: number, height: number}, get screen resolution',
);
console.log('Screen resolution:', screenInfo);

await agent.aiAct('move mouse to center of screen');

await agent.aiAssert('The screen has visible content');

console.log('Done. Report file written to ./midscene_run/report/');
