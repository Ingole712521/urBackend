const { Queue, Worker } = require('bullmq');
const connection = require('../config/redis');
const { sendReleaseEmail } = require('../utils/emailService');

// Create the email queue
const emailQueue = new Queue('email-queue', { connection });

// Initialize Worker with Rate Limiting
const worker = new Worker('email-queue', async (job) => {

        if (job.name === 'release-email') {
            const { email, version, title, content, changelogUrl } = job.data;
            try {
                console.log(`[Queue] Processing Release email for: ${email}`);
                await sendReleaseEmail(email, { version, title, content, changelogUrl });
            } catch (error) {
                console.error(`[Queue] Failed to send email to ${email}:`, error);
                throw error;
            }
        }

        if (job.name === 'send-export-email') {
            const { email, downloadUrl, projectName } = job.data;

            console.log(`[EmailWorker] Sending simple export email to ${email} for ${projectName}`);

            const subject = `Export Ready: ${projectName}`;
            
            const textBody = `Hello,

            Your requested database export for the project "${projectName}" is ready.

            You can download your JSON export using the following secure link (valid for 24 hours):
            ${downloadUrl}

            Thanks,
            urBackend Team`;

            await emailTransporter.sendMail({
                from: '"urBackend" <noreply@urbackend.bitbros.in>',
                to: email,
                subject: subject,
                text: textBody
            });
            
            console.log(`[EmailWorker] Export email successfully sent to ${email}`);
        }

    }, {
        connection,
        limiter: {
            max: 1,
            duration: 900000, // 1 job per 15 minutes (96 per 24 hours) - safe for 100 limit
        }
    });

worker.on('completed', (job) => {
    console.log(`[Queue] Job ${job.id} completed successfully`);
});

worker.on('failed', (job, err) => {
    console.error(`[Queue] Job ${job.id} failed:`, err);
});

module.exports = { emailQueue };
