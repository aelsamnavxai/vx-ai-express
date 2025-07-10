import Bull from 'bull';
import 'dotenv/config';

export const createFollowUpQueue = () => {
    console.log('🔗 Initializing redis at', process.env.REDIS_URL)
    try {
        const redisUrl = process.env.REDIS_URL
        if (!redisUrl) {
            throw new Error('REDIS_URL environment variable is not set');
        }

        const queue = new Bull('follow-ups', redisUrl, {
            redis: {
                maxRetriesPerRequest: null,
                enableReadyCheck: false,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 1000, 5000);
                    console.warn(`Redis connection retry attempt ${times}, retrying in ${delay}ms`);
                    return delay;
                }
            },
            settings: {
                lockDuration: 300000,
                stalledInterval: 300000
            }
        });

        queue.on('error', (error) => {
            console.error('Redis queue error:', error);
        });

        queue.on('waiting', (jobId) => {
            console.log(`Job ${jobId} is waiting to be processed`);
        });

        return queue;
    } catch (error) {
        console.error('Failed to create Redis queue:', error);
        throw error;
    }
};