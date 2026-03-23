#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();
const searchRoots = ['apps', 'packages'];
const sourceFilePattern = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const ignoredDirectories = new Set([
  'dist',
  'node_modules',
  '.turbo',
  '.next',
  'coverage',
]);
const deepImportPattern =
  /from\s+['"](?:\.\.\/)+packages\/[^/'"]+\/src(?:\/[^'"]*)?['"]|import\s*\(\s*['"](?:\.\.\/)+packages\/[^/'"]+\/src(?:\/[^'"]*)?['"]\s*\)/g;

function walk(directoryPath, output) {
  if (!fs.existsSync(directoryPath)) {
    return;
  }

  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath, output);
      continue;
    }

    if (!sourceFilePattern.test(entry.name)) {
      continue;
    }

    output.push(absolutePath);
  }
}

const sourceFiles = [];
for (const relativeRoot of searchRoots) {
  walk(path.join(repoRoot, relativeRoot), sourceFiles);
}

const violations = [];
for (const sourceFile of sourceFiles) {
  const contents = fs.readFileSync(sourceFile, 'utf8');
  const matches = contents.match(deepImportPattern);
  if (!matches || matches.length === 0) {
    continue;
  }

  violations.push({
    sourceFile,
    matches,
  });
}

if (violations.length === 0) {
  console.log('No deep sibling-package src imports detected.');
  process.exit(0);
}

for (const violation of violations) {
  console.error(path.relative(repoRoot, violation.sourceFile));
  for (const match of violation.matches) {
    console.error(`  ${match}`);
  }
}

process.exit(1);
