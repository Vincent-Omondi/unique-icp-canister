import { v4 as uuidv4 } from 'uuid';
import { Server, StableBTreeMap, ic, query, update } from 'azle';
import express from 'express';

// Define the main types for our digital asset registry
class DigitalAsset {
    id: string;
    title: string;
    description: string;
    assetType: AssetType;
    creatorId: string;
    contentHash: string;  // Hash of the digital content
    registrationDate: Date;
    lastModified: Date;
    transferHistory: Transfer[];
    status: AssetStatus;
    metadata: AssetMetadata;
}

enum AssetType {
    IMAGE = "IMAGE",
    AUDIO = "AUDIO",
    VIDEO = "VIDEO",
    DOCUMENT = "DOCUMENT",
    CODE = "CODE"
}

enum AssetStatus {
    ACTIVE = "ACTIVE",
    TRANSFERRED = "TRANSFERRED",
    REVOKED = "REVOKED",
    DELETED = "DELETED"
}

class Transfer {
    id: string;
    fromId: string;
    toId: string;
    transferDate: Date;
    transferType: TransferType;
}

enum TransferType {
    FULL = "FULL",
    LICENSE = "LICENSE"
}

class AssetMetadata {
    fileFormat: string;
    fileSize: number;
    dimensions?: string;
    duration?: number;
    additionalTags: string[];
}

// Storage for different aspects of the registry
const assetStorage = StableBTreeMap<string, DigitalAsset>(0);
const creatorAssets = StableBTreeMap<string, string[]>(1);  // Creator ID to Asset IDs mapping
const assetTransfers = StableBTreeMap<string, Transfer[]>(2);

// Custom error class
class AppError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
    }
}

// Rate limiter
const rateLimiter = new Map<string, number>();

export default Server(() => {
    const app = express();
    app.use(express.json());

    // Register a new digital asset
    app.post("/assets", (req, res) => {
        try {
            if (!rateLimit(req.body.creatorId, 10)) {
                throw new AppError("Too many requests", 429);
            }

            validateAssetRegistration(req.body);
            
            const assetId = uuidv4();
            const asset: DigitalAsset = {
                id: assetId,
                title: req.body.title,
                description: req.body.description,
                assetType: req.body.assetType,
                creatorId: req.body.creatorId,
                contentHash: req.body.contentHash,
                registrationDate: getCurrentDate(),
                lastModified: getCurrentDate(),
                transferHistory: [],
                status: AssetStatus.ACTIVE,
                metadata: req.body.metadata
            };

            // Store the asset
            assetStorage.insert(assetId, asset);

            // Update creator's asset list
            const creatorAssetList = creatorAssets.get(req.body.creatorId);
            if ("None" in creatorAssetList) {
                creatorAssets.insert(req.body.creatorId, [assetId]);
            } else {
                creatorAssets.insert(req.body.creatorId, [...creatorAssetList.Some, assetId]);
            }

            log(`Asset created: ${assetId}`, 'INFO');
            res.json(asset);
        } catch (error) {
            log(`Error creating asset: ${error.message}`, 'ERROR');
            handleError(res, error);
        }
    });

    // Get asset by ID
    app.get("/assets/:id", (req, res) => {
        try {
            const assetOpt = assetStorage.get(req.params.id);
            if ("None" in assetOpt) {
                throw new AppError("Asset not found", 404);
            }
            res.json(assetOpt.Some);
        } catch (error) {
            handleError(res, error);
        }
    });

    // Get all assets by creator ID (with pagination)
    app.get("/creators/:creatorId/assets", (req, res) => {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 10;
            const creatorAssetsOpt = creatorAssets.get(req.params.creatorId);
            if ("None" in creatorAssetsOpt) {
                return res.json({ assets: [], total: 0, page, limit });
            }
            const allAssets = creatorAssetsOpt.Some;
            const startIndex = (page - 1) * limit;
            const endIndex = page * limit;
            const paginatedAssets = allAssets.slice(startIndex, endIndex).map(assetId => {
                const asset = assetStorage.get(assetId);
                return "None" in asset ? null : asset.Some;
            }).filter(asset => asset !== null);
            res.json({
                assets: paginatedAssets,
                total: allAssets.length,
                page,
                limit
            });
        } catch (error) {
            handleError(res, error);
        }
    });

    // Transfer asset ownership
    app.post("/assets/:id/transfer", (req, res) => {
        try {
            if (!isAuthorized(req.params.id, req.body.fromId)) {
                throw new AppError("Unauthorized", 403);
            }

            const { toId, transferType } = req.body;
            const assetOpt = assetStorage.get(req.params.id);

            if ("None" in assetOpt) {
                throw new AppError("Asset not found", 404);
            }

            const asset = assetOpt.Some;
            if (asset.status !== AssetStatus.ACTIVE) {
                throw new AppError("Asset is not available for transfer", 400);
            }

            // Create transfer record
            const transfer: Transfer = {
                id: uuidv4(),
                fromId: asset.creatorId,
                toId: toId,
                transferDate: getCurrentDate(),
                transferType: transferType
            };

            // Update asset
            const updatedAsset = {
                ...asset,
                transferHistory: [...asset.transferHistory, transfer],
                status: transferType === TransferType.FULL ? AssetStatus.TRANSFERRED : AssetStatus.ACTIVE,
                lastModified: getCurrentDate()
            };

            // If full transfer, update creator mappings
            if (transferType === TransferType.FULL) {
                // Remove from old creator's list
                const oldCreatorAssets = creatorAssets.get(asset.creatorId).Some;
                creatorAssets.insert(
                    asset.creatorId,
                    oldCreatorAssets.filter(id => id !== asset.id)
                );

                // Add to new creator's list
                const newCreatorAssetsOpt = creatorAssets.get(toId);
                if ("None" in newCreatorAssetsOpt) {
                    creatorAssets.insert(toId, [asset.id]);
                } else {
                    creatorAssets.insert(toId, [...newCreatorAssetsOpt.Some, asset.id]);
                }
            }

            assetStorage.insert(asset.id, updatedAsset);
            log(`Asset transferred: ${asset.id}`, 'INFO');
            res.json(updatedAsset);
        } catch (error) {
            log(`Error transferring asset: ${error.message}`, 'ERROR');
            handleError(res, error);
        }
    });

    // Update asset metadata
    app.put("/assets/:id/metadata", (req, res) => {
        try {
            if (!isAuthorized(req.params.id, req.body.creatorId)) {
                throw new AppError("Unauthorized", 403);
            }

            const assetOpt = assetStorage.get(req.params.id);
            if ("None" in assetOpt) {
                throw new AppError("Asset not found", 404);
            }

            const asset = assetOpt.Some;
            const updatedAsset = {
                ...asset,
                metadata: {
                    ...asset.metadata,
                    ...req.body.metadata
                },
                lastModified: getCurrentDate()
            };

            assetStorage.insert(asset.id, updatedAsset);
            log(`Asset metadata updated: ${asset.id}`, 'INFO');
            res.json(updatedAsset);
        } catch (error) {
            log(`Error updating asset metadata: ${error.message}`, 'ERROR');
            handleError(res, error);
        }
    });

    // Revoke asset
    app.post("/assets/:id/revoke", (req, res) => {
        try {
            if (!isAuthorized(req.params.id, req.body.creatorId)) {
                throw new AppError("Unauthorized", 403);
            }

            const assetOpt = assetStorage.get(req.params.id);
            if ("None" in assetOpt) {
                throw new AppError("Asset not found", 404);
            }

            const asset = assetOpt.Some;
            if (asset.status === AssetStatus.REVOKED) {
                throw new AppError("Asset is already revoked", 400);
            }

            const updatedAsset = {
                ...asset,
                status: AssetStatus.REVOKED,
                lastModified: getCurrentDate()
            };

            assetStorage.insert(asset.id, updatedAsset);
            log(`Asset revoked: ${asset.id}`, 'INFO');
            res.json(updatedAsset);
        } catch (error) {
            log(`Error revoking asset: ${error.message}`, 'ERROR');
            handleError(res, error);
        }
    });

    // Soft delete asset
    app.delete("/assets/:id", (req, res) => {
        try {
            if (!isAuthorized(req.params.id, req.body.creatorId)) {
                throw new AppError("Unauthorized", 403);
            }

            const assetOpt = assetStorage.get(req.params.id);
            if ("None" in assetOpt) {
                throw new AppError("Asset not found", 404);
            }

            const asset = assetOpt.Some;
            const updatedAsset = {
                ...asset,
                status: AssetStatus.DELETED,
                lastModified: getCurrentDate()
            };

            assetStorage.insert(asset.id, updatedAsset);
            log(`Asset deleted: ${asset.id}`, 'INFO');
            res.json({ message: "Asset deleted successfully" });
        } catch (error) {
            log(`Error deleting asset: ${error.message}`, 'ERROR');
            handleError(res, error);
        }
    });

    return app.listen();
});

// Utility Functions
function getCurrentDate(): Date {
    const timestampNs = ic.time();
    return new Date(Number(timestampNs / BigInt(1_000_000)));
}

function validateAssetRegistration(data: any): void {
    if (!data.title || typeof data.title !== 'string' || data.title.length > 100) {
        throw new AppError("Invalid title", 400);
    }
    if (!data.creatorId || typeof data.creatorId !== 'string' || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(data.creatorId)) {
        throw new AppError("Invalid creator ID", 400);
    }
    if (!data.contentHash || typeof data.contentHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(data.contentHash)) {
        throw new AppError("Invalid content hash", 400);
    }
    if (!Object.values(AssetType).includes(data.assetType)) {
        throw new AppError("Invalid asset type", 400);
    }
    if (!data.metadata || typeof data.metadata !== 'object') {
        throw new AppError("Invalid metadata", 400);
    }
}

function isAuthorized(assetId: string, userId: string): boolean {
    const assetOpt = assetStorage.get(assetId);
    if ("None" in assetOpt) {
        return false;
    }
    return assetOpt.Some.creatorId === userId;
}

function rateLimit(userId: string, limit: number): boolean {
    const now = Date.now();
    const userRequests = rateLimiter.get(userId) || 0;
    if (userRequests >= limit) {
        return false;
    }
    rateLimiter.set(userId, userRequests + 1);
    setTimeout(() => rateLimiter.set(userId, userRequests), 60000); // Reset after 1 minute
    return true;
}

function handleError(res: express.Response, error: any) {
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    res.status(statusCode).json({ error: error.message });
}

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
    const timestamp = getCurrentDate().toISOString();
    ic.print(`[${timestamp}] [${level}] ${message}`);
}