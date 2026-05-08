'use strict';

process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/0";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "0123456789012345678901234567890a";

// Removed resend mock because mail.controller no longer imports it

jest.mock('@urbackend/common', () => {
    const { sendMailSchema } = require('../../../../packages/common/src/utils/input.validation');
    const redisMock = {
        status: 'ready',
        incr: jest.fn(),
        expire: jest.fn(),
        decr: jest.fn(),
        eval: jest.fn(),
    };

    return {
        sendMailSchema,
        Project: { findById: jest.fn() },
        MailTemplate: {
            findOne: jest.fn(() => ({
                lean: jest.fn(async () => null),
            })),
        },
        decrypt: jest.fn(),
        redis: redisMock,
        getPlanLimits: jest.fn(() => ({ mailPerMonth: 100 })),
        publicEmailQueue: {
            add: jest.fn(() => Promise.resolve({ id: 'job-123' }))
        }
    };
});

const { Project, decrypt, redis, publicEmailQueue } = require('@urbackend/common');
const mailController = require('../controllers/mail.controller');

const makeReq = () => ({
    keyRole: 'secret',
    project: { _id: 'proj_1' },
    body: { to: 'user@example.com', subject: 'Hello', text: 'This is a message.' },
    planLimits: { mailTemplatesEnabled: true },
});

const makeRes = () => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
};

const mockProjectConfig = (payload) => {
    Project.findById.mockReturnValue({
        select: jest.fn(() => ({
            lean: jest.fn(() => Promise.resolve(payload)),
        })),
    });
};

describe('mail.controller', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.RESEND_API_KEY = 'default-key';
        process.env.EMAIL_FROM = 'mail@urbackend.app';
    });

    test('sends mail using BYOK key when configured', async () => {
        const req = makeReq();
        const res = makeRes();

        mockProjectConfig({ _id: 'proj_1', resendApiKey: { encrypted: '...' } });
        decrypt.mockReturnValue('byok-key');
        redis.eval.mockResolvedValue(1);

        await mailController.sendMail(req, res);

        expect(redis.eval).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.objectContaining({ provider: 'byok', monthlyUsage: 1 }),
        }));
    });

    test('falls back to default key when BYOK missing', async () => {
        const req = makeReq();
        const res = makeRes();

        mockProjectConfig({ _id: 'proj_1', resendApiKey: null });
        decrypt.mockReturnValue(null);
        redis.eval.mockResolvedValue(2);

        await mailController.sendMail(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ provider: 'default', monthlyUsage: 2 }),
        }));
    });

    test('enforces monthly limit', async () => {
        const req = makeReq();
        const res = makeRes();

        mockProjectConfig({ _id: 'proj_1', resendApiKey: null });
        decrypt.mockReturnValue(null);
        redis.eval.mockResolvedValue(101);

        await mailController.sendMail(req, res);

        expect(redis.decr).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            message: 'Monthly mail limit exceeded.',
        }));
    });

    test('renders and sends a mail template with variables', async () => {
        const req = makeReq();
        req.body = {
            to: 'user@example.com',
            templateName: 'welcome',
            variables: { name: 'Yash' },
        };
        const res = makeRes();

        mockProjectConfig({
            _id: 'proj_1',
            resendApiKey: null,
            mailTemplates: [
                {
                    _id: 'tpl_1',
                    name: 'welcome',
                    subject: 'Hello {{name}}',
                    text: 'Welcome, {{name}}!',
                    html: '<p>Welcome, {{name}}!</p>',
                },
            ],
        });
        decrypt.mockReturnValue(null);
        redis.eval.mockResolvedValue(1);

        await mailController.sendMail(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.objectContaining({
                templateUsed: expect.objectContaining({ name: 'welcome', id: 'tpl_1', scope: 'project' }),
            }),
        }));
        expect(publicEmailQueue.add).toHaveBeenCalledWith("send-public-email", expect.objectContaining({
            payload: expect.objectContaining({
                subject: 'Hello Yash',
                text: 'Welcome, Yash!',
                html: '<p>Welcome, Yash!</p>',
            })
        }), expect.objectContaining({ attempts: expect.any(Number) }));
    });

    test('refunds quota on terminal async worker failure', async () => {
        let failedHandler;
        jest.resetModules();
        jest.doMock('bullmq', () => ({
            Queue: jest.fn(),
            Worker: jest.fn(() => ({
                on: jest.fn((event, handler) => {
                    if (event === 'failed') failedHandler = handler;
                }),
                removeAllListeners: jest.fn(),
                close: jest.fn()
            }))
        }));

        const mockRedis = { eval: jest.fn().mockResolvedValue(0) };
        jest.doMock('../../../../packages/common/src/config/redis', () => mockRedis);

        const { initPublicEmailWorker } = require('../../../../packages/common/src/queues/publicEmailQueue');
        const worker = initPublicEmailWorker();
        
        const mockJob = {
            id: 'job-999',
            data: { consumedQuotaKey: 'project:mail:count:proj_1:2026-05' },
            opts: { attempts: 3 },
            attemptsMade: 3
        };

        expect(failedHandler).toBeDefined();
        await failedHandler(mockJob, new Error("Terminal failure"));

        expect(mockRedis.eval).toHaveBeenCalledWith(
            expect.any(String), 1, 'project:mail:count:proj_1:2026-05'
        );
    });

    test('does not refund quota on non-terminal async worker failure', async () => {
        let failedHandler;
        jest.resetModules();
        jest.doMock('bullmq', () => ({
            Queue: jest.fn(),
            Worker: jest.fn(() => ({
                on: jest.fn((event, handler) => {
                    if (event === 'failed') failedHandler = handler;
                }),
                removeAllListeners: jest.fn(),
                close: jest.fn()
            }))
        }));

        const mockRedis = { eval: jest.fn().mockResolvedValue(0) };
        jest.doMock('../../../../packages/common/src/config/redis', () => mockRedis);

        const { initPublicEmailWorker } = require('../../../../packages/common/src/queues/publicEmailQueue');
        const worker = initPublicEmailWorker();
        
        const mockJob = {
            id: 'job-888',
            data: { consumedQuotaKey: 'project:mail:count:proj_1:2026-05' },
            opts: { attempts: 3 },
            attemptsMade: 1 // Not terminal yet
        };

        expect(failedHandler).toBeDefined();
        await failedHandler(mockJob, new Error("Temporary failure"));

        expect(mockRedis.eval).not.toHaveBeenCalled();
    });
});
