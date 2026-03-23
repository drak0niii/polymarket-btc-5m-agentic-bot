import path from 'path';
import {
  buildDatasetQualityReport,
  persistDatasetQualityReport,
} from './dataset-quality';
import {
  buildEmpiricalWalkForwardSamples,
  loadHistoricalValidationDataset,
} from './p23-validation';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const datasetPathArg = args.find((arg) => arg.startsWith('--dataset='));
  const datasetPath =
    datasetPathArg?.slice('--dataset='.length) ??
    path.resolve(__dirname, './datasets/p23-empirical-validation.dataset.json');
  const evidenceDirArg = args.find((arg) => arg.startsWith('--evidence-dir='));
  const evidenceDir =
    evidenceDirArg?.slice('--evidence-dir='.length) ??
    path.resolve(__dirname, '../../../../artifacts/p23-validation');
  const reportPath = path.join(evidenceDir, 'dataset-quality.latest.json');

  const dataset = loadHistoricalValidationDataset(datasetPath);
  const built = buildEmpiricalWalkForwardSamples(dataset);
  const report = persistDatasetQualityReport(
    reportPath,
    buildDatasetQualityReport({
      dataset,
      datasetPath,
      executableCases: built.executableCases,
      reportPath,
    }),
  );

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict === 'rejected_for_validation') {
    process.exitCode = 1;
  }
}

void main();
