export const workerOperatorCommands = Object.freeze([
  {
    commandId: 'print-daily-decision-quality',
    entrypoint: 'src/commands/print-daily-decision-quality.command.ts',
    description: 'Print the latest daily decision-quality report.',
  },
]);

export class WorkerModule {}
