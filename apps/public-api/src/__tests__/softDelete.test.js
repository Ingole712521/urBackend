'use strict';

const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockLean = jest.fn();

const mockModel = {
    findOneAndUpdate: mockFindOneAndUpdate,
    findOne: mockFindOne,
};

jest.mock('@urbackend/common', () => ({
    sanitize: (v) => v,
    Project: {},
    getConnection: jest.fn().mockResolvedValue({}),
    getCompiledModel: jest.fn(() => mockModel),
    dispatchWebhooks: jest.fn(),
    QueryEngine: jest.fn(),
    validateData: jest.fn(),
    validateUpdateData: jest.fn(),
    isValidId: () => true,
    enqueueCollectionCleanup: jest.fn().mockResolvedValue(true)
}));

const { deleteSingleDoc, getSingleDoc } = require('../controllers/data.controller');

function makeReq(overrides = {}) {
    return {
        params: { collectionName: 'posts', id: '507f1f77bcf86cd799439011' },
        project: {
            _id: 'proj_1',
            resources: { db: { isExternal: false } },
            collections: [{ name: 'posts', model: [] }],
        },
        query: {},
        ...overrides,
    };
}

function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
    return res;
}

describe('Soft Delete in data.controller', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('deleteSingleDoc sets isDeleted: true instead of hard deleting', async () => {
        const req = makeReq();
        const res = makeRes();
        const before = Date.now();

        const doc = { _id: '507f1f77bcf86cd799439011', isDeleted: false };
        mockFindOneAndUpdate.mockReturnValue({
            lean: jest.fn().mockResolvedValue(doc)
        });

        await deleteSingleDoc(req, res);

        expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ _id: '507f1f77bcf86cd799439011', isDeleted: { $ne: true } }),
            expect.objectContaining({
                $set: expect.objectContaining({ isDeleted: true, deletedAt: expect.any(Date) })
            }),
            { new: false }
        );

        const deletedAt = mockFindOneAndUpdate.mock.calls[0][1].$set.deletedAt;
        expect(deletedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(deletedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
        
        expect(res.json).toHaveBeenCalledWith({ 
            success: true, 
            data: { id: '507f1f77bcf86cd799439011' }, 
            message: "Document moved to trash" 
        });
    });

    test('deleteSingleDoc returns 404 if document is already soft-deleted or not found', async () => {
        const req = makeReq();
        const res = makeRes();

        mockFindOneAndUpdate.mockReturnValue({
            lean: jest.fn().mockResolvedValue(null)
        });

        await deleteSingleDoc(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'Document not found.' });
    });
});
