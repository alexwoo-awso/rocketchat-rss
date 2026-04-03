import {
    IPersistence,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import {
    RocketChatAssociationModel,
    RocketChatAssociationRecord,
} from '@rocket.chat/apps-engine/definition/metadata';

import {
    RSS_SUBSCRIPTION_COLLECTION,
} from './constants';
import {
    RssSubscription,
} from './types';

export class RssSubscriptionStore {
    constructor(private readonly read: IRead, private readonly persistence?: IPersistence) {}

    public async getAll(): Promise<Array<RssSubscription>> {
        const records = await this.read.getPersistenceReader().readByAssociation(this.getCollectionAssociation());

        return records
            .map((record) => this.toSubscription(record))
            .filter((subscription): subscription is RssSubscription => Boolean(subscription));
    }

    public async getById(id: string): Promise<RssSubscription | undefined> {
        const records = await this.read.getPersistenceReader().readByAssociation(this.getItemAssociation(id));
        const [record] = records;

        return this.toSubscription(record);
    }

    public async findByFeedUrl(feedUrl: string): Promise<RssSubscription | undefined> {
        const normalizedUrl = normalizeFeedUrl(feedUrl);
        const subscriptions = await this.getAll();

        return subscriptions.find((subscription) => normalizeFeedUrl(subscription.feedUrl) === normalizedUrl);
    }

    public async save(subscription: RssSubscription): Promise<void> {
        if (!this.persistence) {
            throw new Error('Persistence accessor is required to save subscriptions.');
        }

        await this.persistence.updateByAssociations(
            [
                this.getCollectionAssociation(),
                this.getItemAssociation(subscription.id),
                new RocketChatAssociationRecord(RocketChatAssociationModel.ROOM, subscription.roomId),
            ],
            subscription,
            true,
        );
    }

    public async remove(subscriptionId: string): Promise<void> {
        if (!this.persistence) {
            throw new Error('Persistence accessor is required to remove subscriptions.');
        }

        await this.persistence.removeByAssociations([
            this.getCollectionAssociation(),
            this.getItemAssociation(subscriptionId),
        ]);
    }

    private getCollectionAssociation(): RocketChatAssociationRecord {
        return new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, RSS_SUBSCRIPTION_COLLECTION);
    }

    private getItemAssociation(id: string): RocketChatAssociationRecord {
        return new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `${RSS_SUBSCRIPTION_COLLECTION}:${id}`);
    }

    private toSubscription(record: object | undefined): RssSubscription | undefined {
        if (!record || typeof record !== 'object') {
            return undefined;
        }

        const candidate = record as Partial<RssSubscription>;
        if (!candidate.id || !candidate.feedUrl || !candidate.roomId || !candidate.roomName || !candidate.createdAt || !candidate.updatedAt || !candidate.nextRunAt || !Array.isArray(candidate.recentItemKeys)) {
            return undefined;
        }

        return {
            id: candidate.id,
            feedUrl: candidate.feedUrl,
            roomId: candidate.roomId,
            roomName: candidate.roomName,
            intervalMinutes: Number(candidate.intervalMinutes) || 15,
            isPaused: Boolean(candidate.isPaused),
            createdAt: candidate.createdAt,
            updatedAt: candidate.updatedAt,
            nextRunAt: candidate.nextRunAt,
            recentItemKeys: candidate.recentItemKeys,
            feedTitle: candidate.feedTitle,
            lastCheckedAt: candidate.lastCheckedAt,
            lastSuccessAt: candidate.lastSuccessAt,
            lastPostedAt: candidate.lastPostedAt,
            lastError: candidate.lastError,
        };
    }
}

function normalizeFeedUrl(feedUrl: string): string {
    try {
        return new URL(feedUrl).toString();
    } catch {
        return feedUrl.trim();
    }
}
