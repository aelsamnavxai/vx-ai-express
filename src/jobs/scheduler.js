import { createFollowUpQueue } from '../config/redis.js';
import schedule from 'node-schedule';


export const scheduleDailyFollowUps = () => {
    const followUpQueue = createFollowUpQueue();
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