import {
    IPersistence,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import {
    RocketChatAssociationModel,
    RocketChatAssociationRecord,
} from '@rocket.chat/apps-engine/definition/metadata';

import {
    RSS_CHANNEL_CONFIG_COLLECTION,
    RSS_GLOBAL_CONFIG_COLLECTION,
} from './constants';
import {
    RssChannelConfig,
    RssDeliveryIdentityConfig,
} from './types';

interface StoredGlobalConfig {
    updatedAt: string;
    identityConfig?: RssDeliveryIdentityConfig;
}

export class RssConfigStore {
    constructor(private readonly read: IRead, private readonly persistence?: IPersistence) {}

    public async getGlobal(): Promise<RssDeliveryIdentityConfig> {
        const records = await this.read.getPersistenceReader().readByAssociation(this.getGlobalAssociation());
        const [record] = records;

        return this.toIdentityConfig((record as StoredGlobalConfig | undefined)?.identityConfig) ?? {};
    }

    public async saveGlobal(identityConfig: RssDeliveryIdentityConfig): Promise<void> {
        if (!this.persistence) {
            throw new Error('Persistence accessor is required to save RSS config.');
        }

        await this.persistence.updateByAssociation(
            this.getGlobalAssociation(),
            {
                updatedAt: new Date().toISOString(),
                identityConfig: this.toIdentityConfig(identityConfig),
            },
            true,
        );
    }

    public async getChannel(roomId: string): Promise<RssChannelConfig | undefined> {
        const records = await this.read.getPersistenceReader().readByAssociation(this.getChannelAssociation(roomId));
        const [record] = records;

        return this.toChannelConfig(record);
    }

    public async saveChannel(config: RssChannelConfig): Promise<void> {
        if (!this.persistence) {
            throw new Error('Persistence accessor is required to save RSS config.');
        }

        await this.persistence.updateByAssociations(
            [
                this.getChannelCollectionAssociation(),
                this.getChannelAssociation(config.roomId),
            ],
            {
                ...config,
                identityConfig: this.toIdentityConfig(config.identityConfig),
                updatedAt: new Date().toISOString(),
            },
            true,
        );
    }

    private getGlobalAssociation(): RocketChatAssociationRecord {
        return new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, RSS_GLOBAL_CONFIG_COLLECTION);
    }

    private getChannelCollectionAssociation(): RocketChatAssociationRecord {
        return new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, RSS_CHANNEL_CONFIG_COLLECTION);
    }

    private getChannelAssociation(roomId: string): RocketChatAssociationRecord {
        return new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `${RSS_CHANNEL_CONFIG_COLLECTION}:${roomId}`);
    }

    private toChannelConfig(record: object | undefined): RssChannelConfig | undefined {
        if (!record || typeof record !== 'object') {
            return undefined;
        }

        const candidate = record as Partial<RssChannelConfig>;
        if (!candidate.roomId || !candidate.roomName || !candidate.updatedAt) {
            return undefined;
        }

        return {
            roomId: candidate.roomId,
            roomName: candidate.roomName,
            updatedAt: candidate.updatedAt,
            identityConfig: this.toIdentityConfig(candidate.identityConfig),
        };
    }

    private toIdentityConfig(config: Partial<RssDeliveryIdentityConfig> | undefined): RssDeliveryIdentityConfig | undefined {
        if (!config || typeof config !== 'object') {
            return undefined;
        }

        const identityConfig: RssDeliveryIdentityConfig = {
            avatarUrl: sanitizeOptionalString(config.avatarUrl),
            displayName: sanitizeOptionalString(config.displayName),
            senderUsername: sanitizeOptionalString(config.senderUsername),
        };

        return identityConfig.avatarUrl || identityConfig.displayName || identityConfig.senderUsername
            ? identityConfig
            : undefined;
    }
}

function sanitizeOptionalString(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
}
