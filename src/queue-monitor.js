import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { createFollowUpQueue } from './config/redis';
import express from 'express';

const queue = createFollowUpQueue();
const serverAdapter = new ExpressAdapter();

createBullBoard({
    queues: [new BullAdapter(queue)],
    serverAdapter
});

const app = express();
serverAdapter.setBasePath('/admin/queues');
app.use('/admin/queues', serverAdapter.getRouter());

app.listen(3001, () => {
    console.log('📊 Bull Dashboard at http://localhost:3001/admin/queues');
});