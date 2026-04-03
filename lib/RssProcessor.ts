import {
    IHttp,
    IModify,
    IPersistence,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import {
    IJobContext,
    IProcessor,
    IRecurringStartup,
    StartupType,
} from '@rocket.chat/apps-engine/definition/scheduler';

import {
    DEFAULT_SCHEDULER_INTERVAL,
    MAX_RECENT_ITEM_KEYS,
    RSS_POLL_PROCESSOR_ID,
} from './constants';
import {
    RssFeedReader,
} from './RssFeedReader';
import {
    RssSubscriptionStore,
} from './RssSubscriptionStore';
import {
    ProcessSubscriptionResult,
    RssFeedItem,
    RssSubscription,
} from './types';
import {
    RssFeedApp,
} from '../RssFeedApp';
import {
    RssSetting,
} from '../config/Settings';

export class RssProcessor implements IProcessor {
    public id = RSS_POLL_PROCESSOR_ID;
    public startupSetting: IRecurringStartup = {
        type: StartupType.RECURRING,
        interval: DEFAULT_SCHEDULER_INTERVAL,
        skipImmediate: true,
    };
    private readonly reader = new RssFeedReader();

    constructor(private readonly app: RssFeedApp) {}

    public async processor(_jobContext: IJobContext, read: IRead, modify: IModify, http: IHttp, persistence: IPersistence): Promise<void> {
        const store = new RssSubscriptionStore(read, persistence);
        const subscriptions = await store.getAll();

        for (const subscription of subscriptions) {
            if (!this.shouldRun(subscription)) {
                continue;
            }

            await this.processSubscription(subscription, read, modify, http, persistence);
        }
    }

    public async processSubscription(
        subscription: RssSubscription,
        read: IRead,
        modify: IModify,
        http: IHttp,
        persistence: IPersistence,
        force = false,
    ): Promise<ProcessSubscriptionResult> {
        const store = new RssSubscriptionStore(read, persistence);
        const now = new Date();

        if (subscription.isPaused && !force) {
            return {
                subscription,
                deliveredCount: 0,
                detectedCount: 0,
                bootstrapItemCount: 0,
                dryRun: false,
                skipped: 'Subscription is paused.',
            };
        }

        try {
            const feed = await this.reader.readFeed(subscription.feedUrl, read, http);
            const newItems = this.getNewItems(subscription, feed.items);
            const isBootstrap = !subscription.lastSuccessAt && !subscription.recentItemKeys.length;
            const dryRun = Boolean(await read.getEnvironmentReader().getSettings().getValueById(RssSetting.DryRunMode));
            const deliveredCount = isBootstrap
                ? 0
                : await this.deliverItems(subscription, feed.title, newItems, read, modify, dryRun);

            const updatedSubscription: RssSubscription = {
                ...subscription,
                feedTitle: feed.title,
                lastCheckedAt: now.toISOString(),
                lastSuccessAt: now.toISOString(),
                lastPostedAt: deliveredCount > 0 ? now.toISOString() : subscription.lastPostedAt,
                lastError: undefined,
                nextRunAt: addMinutes(now, subscription.intervalMinutes).toISOString(),
                recentItemKeys: this.mergeRecentKeys(subscription.recentItemKeys, feed.items),
                updatedAt: now.toISOString(),
            };

            await store.save(updatedSubscription);

            return {
                subscription: updatedSubscription,
                feedTitle: feed.title,
                deliveredCount,
                detectedCount: newItems.length,
                bootstrapItemCount: isBootstrap ? feed.items.length : 0,
                dryRun,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown feed processing error.';
            const updatedSubscription: RssSubscription = {
                ...subscription,
                lastCheckedAt: now.toISOString(),
                lastError: message,
                nextRunAt: addMinutes(now, subscription.intervalMinutes).toISOString(),
                updatedAt: now.toISOString(),
            };

            await store.save(updatedSubscription);
            this.app.getLogger().error(`RSS poll failed for ${subscription.feedUrl}: ${message}`);

            return {
                subscription: updatedSubscription,
                deliveredCount: 0,
                detectedCount: 0,
                bootstrapItemCount: 0,
                dryRun: false,
                error: message,
            };
        }
    }

    private shouldRun(subscription: RssSubscription): boolean {
        if (subscription.isPaused) {
            return false;
        }

        const nextRunAt = Date.parse(subscription.nextRunAt);
        if (Number.isNaN(nextRunAt)) {
            return true;
        }

        return nextRunAt <= Date.now();
    }

    private getNewItems(subscription: RssSubscription, items: Array<RssFeedItem>): Array<RssFeedItem> {
        const known = new Set(subscription.recentItemKeys);

        return items
            .filter((item) => !known.has(item.key))
            .reverse();
    }

    private mergeRecentKeys(existing: Array<string>, items: Array<RssFeedItem>): Array<string> {
        const merged = [...items.map((item) => item.key), ...existing];
        return Array.from(new Set(merged)).slice(0, MAX_RECENT_ITEM_KEYS);
    }

    private async deliverItems(
        subscription: RssSubscription,
        feedTitle: string,
        items: Array<RssFeedItem>,
        read: IRead,
        modify: IModify,
        dryRun: boolean,
    ): Promise<number> {
        if (!items.length || dryRun) {
            return 0;
        }

        const room = await read.getRoomReader().getById(subscription.roomId);
        const appUser = await read.getUserReader().getAppUser();
        if (!room || !appUser) {
            throw new Error('Target room or app user is unavailable.');
        }

        for (const item of items) {
            const builder = modify.getCreator().startMessage();
            builder
                .setRoom(room)
                .setSender(appUser)
                .setGroupable(false)
                .setText(this.buildMessageText(feedTitle, item));

            if (item.summary || item.author || item.publishedAt) {
                builder.addAttachment({
                    color: '#1d74f5',
                    title: {
                        value: item.title,
                        link: item.url,
                    },
                    text: item.summary,
                    author: item.author ? { name: item.author } : undefined,
                    timestamp: item.publishedAt ? new Date(item.publishedAt) : undefined,
                });
            }

            await modify.getCreator().finish(builder);
        }

        return items.length;
    }

    private buildMessageText(feedTitle: string, item: RssFeedItem): string {
        const lines = [
            `**${feedTitle}**`,
            item.url ? `<${item.url}|${item.title}>` : item.title,
        ];

        if (item.summary) {
            lines.push(truncate(item.summary, 350));
        }

        return lines.join('\n');
    }
}

function addMinutes(value: Date, minutes: number): Date {
    return new Date(value.getTime() + minutes * 60 * 1000);
}

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
