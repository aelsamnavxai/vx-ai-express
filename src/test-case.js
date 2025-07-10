import { createFollowUpQueue } from './config/redis';
import { processDailyFollowUps } from './services/followup-service';

const followUpQueue = createFollowUpQueue();

// Manually add a test job
async function testQueue() {
    console.log('🧪 Adding TEST job to queue...');

    const testJob = await followUpQueue.add('TEST_FOLLOW_UPS', {}, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false
    });

    console.log(`✅ Test job added (ID: ${testJob.id})`);
}

// Run test
testQueue().catch(console.error);