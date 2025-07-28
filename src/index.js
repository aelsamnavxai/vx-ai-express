import express from 'express';
import 'dotenv/config'; // Load environment variables from .env file
import { scheduleDailyFollowUps } from './jobs/scheduler.js';
import './jobs/followup-processor.js'; // Import to ensure the processor is registered

const app = express();
const port = process.env.PORT || 3000;

// Body parsing Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Start the daily follow-up scheduler
if(process.env.NODE_ENV === 'production') {
    scheduleDailyFollowUps();
}

app.get('/', async (req, res)=> {
    return res.status(200).send({
        message: 'Server is running successfully',
        timeStamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',

    });
});

try {
    app.listen(port, () => {
        console.log(`Connected successfully on port ${port}`);
    });
} catch (error) {
    console.error(`Error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`);
}