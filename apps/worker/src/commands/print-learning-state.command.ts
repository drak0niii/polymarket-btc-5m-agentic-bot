import { LearningEventLog } from '@worker/runtime/learning-event-log';
import { LearningStateStore } from '@worker/runtime/learning-state-store';
import { VenueHealthLearningStore } from '@polymarket-btc-5m-agentic-bot/polymarket-adapter';

async function main(): Promise<void> {
  const learningStateStore = new LearningStateStore();
  const learningEventLog = new LearningEventLog();
  const venueHealthLearningStore = new VenueHealthLearningStore();

  const [state, events, venueHealth] = await Promise.all([
    learningStateStore.load(),
    learningEventLog.readLatest(20),
    venueHealthLearningStore.getCurrentMetrics(),
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        state,
        recentEvents: events,
        venueHealth,
      },
      null,
      2,
    )}\n`,
  );
}

void main();
