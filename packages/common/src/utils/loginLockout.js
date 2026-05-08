const redis = require('../config/redis');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 15 * 60;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const getFailureKey = (projectId, email) => {
  const normalizedEmail = normalizeEmail(email);
  return `project:auth:login:failures:${projectId}:${normalizedEmail}`;
};

const getLockKey = (projectId, email) => {
  const normalizedEmail = normalizeEmail(email);
  return `project:auth:login:lock:${projectId}:${normalizedEmail}`;
};

const checkLockout = async (projectId, email) => {
  const lockKey = getLockKey(projectId, email);
  const isLocked = await redis.get(lockKey);

  if (!isLocked) {
    return {
      locked: false,
      retryAfterSeconds: 0,
    };
  }

  const ttl = await redis.ttl(lockKey);
  return {
    locked: true,
    retryAfterSeconds: ttl > 0 ? ttl : LOCKOUT_SECONDS,
  };
};

const recordFailedAttempt = async (projectId, email) => {
  const lockStatus = await checkLockout(projectId, email);
  if (lockStatus.locked) {
    return {
      ...lockStatus,
      attempts: MAX_FAILED_ATTEMPTS,
    };
  }

  const failureKey = getFailureKey(projectId, email);
  const lockKey = getLockKey(projectId, email);

  const attempts = await redis.incr(failureKey);
  if (attempts === 1) {
    await redis.expire(failureKey, LOCKOUT_SECONDS);
  }

  if (attempts >= MAX_FAILED_ATTEMPTS) {
    await redis.set(lockKey, '1', 'EX', LOCKOUT_SECONDS);
    await redis.del(failureKey);

    return {
      locked: true,
      retryAfterSeconds: LOCKOUT_SECONDS,
      attempts,
    };
  }

  return {
    locked: false,
    retryAfterSeconds: 0,
    attempts,
  };
};

const clearLockout = async (projectId, email) => {
  const failureKey = getFailureKey(projectId, email);
  const lockKey = getLockKey(projectId, email);
  await redis.del(failureKey, lockKey);
};

module.exports = {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_SECONDS,
  checkLockout,
  recordFailedAttempt,
  clearLockout,
};
