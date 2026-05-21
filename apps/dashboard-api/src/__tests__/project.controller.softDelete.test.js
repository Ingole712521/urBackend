'use strict';

const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();

const mockModel = {
    findOneAndUpdate: mockFindOneAndUpdate,
};

jest.mock('@urbackend/common', () => ({
    Project: {
        findOne: mockFindOne,
    },
    getConnection: jest.fn().mockResolvedValue({}),
    getCompiledModel: jest.fn(() => mockModel),
    enqueueCollectionCleanup: jest.fn().mockResolvedValue(true)
}));

const { deleteRow } = require('../controllers/project.controller');

function makeReq() {
    return {
        params: { projectId: 'proj_1', collectionName: 'posts', id: '507f1f77bcf86cd799439011' },
        user: { _id: 'user_1' }
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

describe('Soft Delete in dashboard project.controller', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('deleteRow sets isDeleted: true instead of hard deleting', async () => {
        const req = makeReq();
        const res = makeRes();

        // Mock project
        const project = {
            _id: 'proj_1',
            resources: { db: { isExternal: false } },
            collections: [{ name: 'posts', model: [] }],
            save: jest.fn().mockResolvedValue(true)
        };
        mockFindOne.mockResolvedValue(project);

        // Mock document
        const doc = { _id: '507f1f77bcf86cd799439011', isDeleted: false };
        mockFindOneAndUpdate.mockReturnValue({
            lean: jest.fn().mockResolvedValue(doc)
        });

        await deleteRow(req, res);

        expect(mockFindOne).toHaveBeenCalled();
        expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
            { _id: '507f1f77bcf86cd799439011', isDeleted: { $ne: true } },
            expect.objectContaining({
                $set: expect.objectContaining({ isDeleted: true, deletedAt: expect.any(Date) })
            }),
            { new: false }
        );
        
        expect(res.json).toHaveBeenCalledWith({ 
            success: true, 
            data: { id: '507f1f77bcf86cd799439011' }, 
            message: "Document moved to trash" 
        });
        
        // Should not save project (to update databaseUsed) since it's a soft delete
        expect(project.save).not.toHaveBeenCalled();
    });

    test('deleteRow returns 404 if document is already soft-deleted or not found', async () => {
        const req = makeReq();
        const res = makeRes();

        // Mock project
        const project = {
            _id: 'proj_1',
            resources: { db: { isExternal: false } },
            collections: [{ name: 'posts', model: [] }],
            save: jest.fn().mockResolvedValue(true)
        };
        mockFindOne.mockResolvedValue(project);

        mockFindOneAndUpdate.mockReturnValue({
            lean: jest.fn().mockResolvedValue(null)
        });

        await deleteRow(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ 
            success: false, 
            data: {}, 
            message: "Document not found." 
        });
    });
});
