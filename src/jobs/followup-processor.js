import { createFollowUpQueue } from '../config/redis';
import { processDailyFollowUps } from '../services/followup-service';

const followUpQueue = createFollowUpQueue();

followUpQueue.process('process-follow-ups', async (job) => {
    console.log('🔧 Processing daily follow-ups job');
    await processDailyFollowUps();
    console.log('✅ Completed daily follow-ups');
});

followUpQueue.on('failed', (job, err) => {
    console.error('❌ Job failed:', job?.id, err);
});

// Add this to your worker startup
followUpQueue.on('error', (err) => {
    console.error('QUEUE ERROR:', err);
});

followUpQueue.on('failed', (job, err) => {
    console.error(`JOB ${job.id} FAILED:`, err);
});

console.log('🚀 Worker ready for followups')