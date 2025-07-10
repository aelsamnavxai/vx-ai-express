import { createFollowUpQueue } from '../config/redis';
import schedule from 'node-schedule';

const followUpQueue = createFollowUpQueue();

export const scheduleDailyFollowUps = () => {
    // 12 PM in the server's timezone
    const rule = new schedule.RecurrenceRule();
    rule.hour = 12;
    rule.minute = 0;

    schedule.scheduleJob(rule, async () => {
        console.log('🚀 Starting daily follow-ups at', new Date().toISOString());

        await followUpQueue.add('process-follow-ups', {}, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: false
        });
    });
};