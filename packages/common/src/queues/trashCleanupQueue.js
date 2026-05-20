const { Queue, Worker } = require('bullmq');
const connection = require('../config/redis');
const Project = require('../models/Project');
const { getConnection } = require('../utils/connection.manager');
const { getCompiledModel } = require('../utils/injectModel');

const QUEUE_NAME = 'trash-cleanup-queue';
const trashCleanupQueue = new Queue(QUEUE_NAME, { connection });

/**
 * Enqueue a cleanup job for a specific collection.
 */
async function enqueueCollectionCleanup(projectId, collectionName, delay = 0) {
  try {
    const baseJobId = `${encodeURIComponent(projectId)}-${encodeURIComponent(collectionName)}`;
    const jobId = delay > 0 ? `${baseJobId}-${Date.now()}` : baseJobId;
    
    // Only remove non-active jobs to avoid BullMQ state errors
    const oldJob = await trashCleanupQueue.getJob(baseJobId);
    if (oldJob) {
      const state = await oldJob.getState();
      if (state === 'delayed' || state === 'waiting') {
        try { await oldJob.remove(); } catch (e) { console.warn(`[TrashCleanup] Could not remove existing job ${baseJobId}:`, e.message); }
      }
    }

    await trashCleanupQueue.add(
      'cleanup-collection',
      { projectId, collectionName },
      {
        jobId: jobId,
        delay: Math.max(delay, 0),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: true,
      }
    );
  } catch (err) {
    console.error(`[TrashCleanup] Failed to enqueue cleanup for ${projectId}:${collectionName}:`, err.message);
    throw err;
  }
}

/**
 * Process a collection cleanup job.
 */
async function processCollectionCleanup(projectId, collectionName) {
  const project = await Project.findById(projectId).lean();
  if (!project) return;

  const collectionConfig = project.collections.find(c => c.name === collectionName);
  if (!collectionConfig) return;

  const projectConn = await getConnection(projectId);
  const Model = getCompiledModel(
    projectConn,
    collectionConfig,
    projectId,
    project.resources.db.isExternal
  );

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let totalReclaimedBytes = 0;

  // 1. Batch-delete expired soft-deleted docs
  while (true) {
    let batch;
    try {
        batch = await Model.aggregate([
          { $match: { isDeleted: true, deletedAt: { $lt: thirtyDaysAgo } } },
          { $limit: 500 },
          { $project: { _id: 1, bsonSize: { $bsonSize: '$$ROOT' } } },
        ]);
    } catch (e) {
        // Fallback for older Mongo versions without $bsonSize
        batch = await Model.find({ isDeleted: true, deletedAt: { $lt: thirtyDaysAgo } })
            .select('_id')
            .limit(500)
            .lean();
    }

    if (!batch.length) break;

    const ids = batch.map(d => d._id);
    const reclaimedBytes = batch.reduce((sum, d) => sum + (d.bsonSize || 1024), 0);

    const { deletedCount } = await Model.deleteMany({ 
        _id: { $in: ids },
        isDeleted: true,
        deletedAt: { $lt: thirtyDaysAgo }
    });
    totalReclaimedBytes += (reclaimedBytes * (deletedCount / ids.length));

    if (batch.length < 500) break;
  }

  // 2. Atomic databaseUsed decrement
  if (totalReclaimedBytes > 0 && !project.resources.db.isExternal) {
    await Project.updateOne(
      { _id: projectId },
      [{ 
        $set: { 
          databaseUsed: { 
            $max: [0, { $subtract: [{ $ifNull: ['$databaseUsed', 0] }, totalReclaimedBytes] }] 
          } 
        } 
      }]
    );
  }

  // 3. Self-schedule
  const nextPending = await Model.findOne(
    { isDeleted: true, deletedAt: { $gte: thirtyDaysAgo } },
    { deletedAt: 1 },
    { sort: { deletedAt: 1 } }
  ).lean();

  if (nextPending && nextPending.deletedAt) {
    const nextRunDelay = nextPending.deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000 - Date.now();
    const delay = Math.max(nextRunDelay, 0);
    await enqueueCollectionCleanup(projectId, collectionName, delay);
  }
}

async function runFullTrashCleanup() {
  console.log('[TrashCleanup] Starting manual full sweep...');
  const projects = await Project.find({}).lean();
  for (const project of projects) {
    for (const col of project.collections) {
      await enqueueCollectionCleanup(project._id.toString(), col.name);
    }
  }
}

function initTrashCleanupWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { projectId, collectionName } = job.data;
      await processCollectionCleanup(projectId, collectionName);
    },
    { connection, concurrency: 1 }
  );

  worker.on('completed', (job) => console.log(`[TrashCleanup] Job ${job.id} completed successfully`));
  worker.on('failed', (job, err) =>
    console.error(`[TrashCleanup] Job ${job ? job.id : 'unknown'} failed:`, err.message)
  );

  return worker;
}

module.exports = {
  trashCleanupQueue,
  enqueueCollectionCleanup,
  initTrashCleanupWorker,
  runFullTrashCleanup,
  processCollectionCleanup
};
