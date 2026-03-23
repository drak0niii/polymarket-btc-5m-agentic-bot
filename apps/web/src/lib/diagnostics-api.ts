import { apiClient } from './api';

export const diagnosticsApi = {
  getExecution() {
    return apiClient.getExecutionDiagnostics();
  },

  getEvDrift() {
    return apiClient.getEvDriftDiagnostics();
  },

  getRegimes() {
    return apiClient.getRegimeDiagnostics();
  },

  getStressTests() {
    return apiClient.getStressTestRuns();
  },
};