const dotenv = require('dotenv');
dotenv.config({ path: require('path').join(__dirname, '../../../.env') });

const { Worker } = require('bullmq');
const mongoose = require('mongoose')
const fs = require('fs');
const path = require('path');
const os = require('os');
const { 
    redis, 
    exportQueue, 
    emailQueue,
    Project, 
    getConnection, 
    getCompiledModel, 
    getStorage, 
    getBucket 
} = require('@urbackend/common');

const { validateEnv } = require('@urbackend/common');

if (process.env.NODE_ENV !== 'test') {
    validateEnv();
}

const initExportWorker = () => {
    const worker = new Worker(exportQueue.name, async (job) => {
        const { projectId, userId, email } = job.data;
        console.log(`[ExportWorker] Starting export for project ${projectId} requested by ${email}`);

        const project = await Project.findById(projectId);
        if (!project) throw new Error('Project not found');

        const connection = await getConnection(projectId);
        
        // stream to a local temp file first to prevent memory bloat on large db export
        const tempFilePath = path.join(os.tmpdir(), `export_${projectId}_${Date.now()}.json`);
        const writeStream = fs.createWriteStream(tempFilePath);

        try {
            writeStream.write('{\n');
            
            for (let i = 0; i < project.collections.length; i++) {
                const col = project.collections[i];
                const Model = getCompiledModel(connection, col, projectId, project.resources.db.isExternal);
                
                writeStream.write(`  "${col.name}": [\n`);
                
                // use a mongoose cursor to stream documents one by one
                const cursor = Model.find().lean().cursor();
                let first = true;
                
                for await (const doc of cursor) {
                    if (!first) writeStream.write(',\n');
                    writeStream.write(`    ${JSON.stringify(doc)}`);
                    first = false;
                }
                
                writeStream.write('\n  ]');
                if (i < project.collections.length - 1) writeStream.write(',\n');
            }
            
            writeStream.write('\n}\n');
            writeStream.end();

            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            console.log(`[ExportWorker] Data written to temp file. Uploading to storage...`);

            // upload to supabase / storage
            const supabase = await getStorage(project);
            const bucket = getBucket(project);
            const storagePath = `${projectId}/exports/db_export_${Date.now()}.json`;
            
            const fileBuffer = fs.readFileSync(tempFilePath);
            const { error: uploadError } = await supabase.storage
                .from(bucket)
                .upload(storagePath, fileBuffer, { contentType: 'application/json', upsert: true });

            if (uploadError) throw uploadError;

            // create a signed URL valid for 24 hrs (86400 seconds)
            const { data: signedData, error: signedError } = await supabase.storage
                .from(bucket)
                .createSignedUrl(storagePath, 86400);

            if (signedError) throw signedError;

            // queue the email to be sent to the user
            await emailQueue.add('send-export-email', { email, downloadUrl: signedData.signedUrl, projectName: project.name });
            console.log(`[ExportWorker] Export completed! Email queued for ${email}`);

        } finally {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        }
    }, { connection: redis, concurrency: 2 });

    worker.on('completed', (job) => {
        console.log(`[ExportWorker] Job ${job.id} for project ${job.data.projectId} completed.`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[ExportWorker] Job ${job?.id} for project ${job?.data?.projectId} failed:`, err.message);
    });

    return worker;
};

if (require.main === module) {

    const { connectDB } = require('@urbackend/common');

    (async () => {
        try {
            await connectDB();

            initExportWorker();

            console.log('[CONSUMER] Export worker started and listening for jobs...');
        } catch (err) {
            console.error('Failed to start worker:', err);
            process.exit(1);
        }
    })();
}
module.exports = { initExportWorker };