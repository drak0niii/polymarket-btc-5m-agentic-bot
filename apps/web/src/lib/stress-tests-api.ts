import { apiClient } from './api';

export const stressTestsApi = {
  listRuns() {
    return apiClient.getStressTestRuns();
  },
};