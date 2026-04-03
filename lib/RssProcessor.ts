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

    public processor = async (
        _jobContext: IJobContext,
        read: IRead,
        modify: IModify,
        http: IHttp,
        persistence: IPersistence,
    ): Promise<void> => {
        const accessors = resolveSchedulerAccessors(modify, http, persistence);
        this.logSchedulerAccessorState(accessors);

        try {
            const store = new RssSubscriptionStore(read, accessors.persistence);
            const subscriptions = await store.getAll();

            for (const subscription of subscriptions) {
                if (!this.shouldRun(subscription)) {
                    continue;
                }

                try {
                    await this.processSubscription(
                        subscription,
                        read,
                        accessors.modify,
                        accessors.http,
                        accessors.persistence,
                    );
                } catch (error) {
                    this.logUnexpectedError(
                        `Unexpected scheduler failure for subscription ${subscription.id} (${subscription.feedUrl})`,
                        error,
                    );
                }
            }
        } catch (error) {
            this.logUnexpectedError('RSS scheduler processor failed before subscription processing started', error);
        }
    };

    public async processSubscription(
        subscription: RssSubscription,
        read: IRead,
        modify: IModify | undefined,
        http: IHttp | undefined,
        persistence: IPersistence | undefined,
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
            if (!http) {
                throw new Error('HTTP accessor is unavailable in the scheduler context.');
            }

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
                nextRunAt: addMinutes(now, subscription.intervalMinutes).toISOString(),
                recentItemKeys: this.mergeRecentKeys(subscription.recentItemKeys, feed.items),
                updatedAt: now.toISOString(),
            };

            await this.saveSubscription(store, {
                ...updatedSubscription,
                lastError: undefined,
            });

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

            await this.saveSubscription(store, updatedSubscription, `Unable to persist RSS failure state for ${subscription.feedUrl}`);
            this.logUnexpectedError(`RSS poll failed for ${subscription.feedUrl}: ${message}`, error);

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
        modify: IModify | undefined,
        dryRun: boolean,
    ): Promise<number> {
        if (!items.length || dryRun) {
            return 0;
        }

        if (!modify) {
            throw new Error('Message creator accessor is unavailable in the scheduler context.');
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

    private async saveSubscription(
        store: RssSubscriptionStore,
        subscription: RssSubscription,
        errorPrefix = `Unable to persist RSS subscription ${subscription.id}`,
    ): Promise<void> {
        try {
            await store.save(subscription);
        } catch (error) {
            this.logUnexpectedError(errorPrefix, error);
        }
    }

    private logUnexpectedError(prefix: string, error: unknown): void {
        if (error instanceof Error) {
            const detail = error.stack ?? error.message;
            this.app.getLogger().error(`${prefix}: ${detail}`);
            return;
        }

        this.app.getLogger().error(`${prefix}: ${String(error)}`);
    }

    private logSchedulerAccessorState(accessors: {
        modify: IModify | undefined;
        http: IHttp | undefined;
        persistence: IPersistence | undefined;
    }): void {
        if (accessors.modify && accessors.http && accessors.persistence) {
            return;
        }

        this.app.getLogger().warn(
            `RSS scheduler accessor availability: modify=${String(Boolean(accessors.modify))}, http=${String(Boolean(accessors.http))}, persistence=${String(Boolean(accessors.persistence))}`,
        );
    }
}

function addMinutes(value: Date, minutes: number): Date {
    return new Date(value.getTime() + minutes * 60 * 1000);
}

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function resolveSchedulerAccessors(
    modify: IModify,
    http: IHttp,
    persistence: IPersistence,
): {
    modify: IModify | undefined;
    http: IHttp | undefined;
    persistence: IPersistence | undefined;
} {
    if (hasModifyAccessor(modify) && hasHttpAccessor(http)) {
        return {
            modify,
            http,
            persistence: hasPersistenceAccessor(persistence) ? persistence : undefined,
        };
    }

    if (hasHttpAccessor(modify as unknown) && hasPersistenceAccessor(http as unknown)) {
        return {
            modify: undefined,
            http: modify as unknown as IHttp,
            persistence: http as unknown as IPersistence,
        };
    }

    return {
        modify: hasModifyAccessor(modify) ? modify : undefined,
        http: hasHttpAccessor(http) ? http : hasHttpAccessor(modify as unknown) ? modify as unknown as IHttp : undefined,
        persistence: hasPersistenceAccessor(persistence)
            ? persistence
            : hasPersistenceAccessor(http as unknown)
                ? http as unknown as IPersistence
                : undefined,
    };
}

function hasModifyAccessor(value: unknown): value is IModify {
    return Boolean(value) && typeof (value as IModify).getCreator === 'function';
}

function hasHttpAccessor(value: unknown): value is IHttp {
    return Boolean(value) && typeof (value as IHttp).get === 'function';
}

function hasPersistenceAccessor(value: unknown): value is IPersistence {
    return Boolean(value)
        && typeof (value as IPersistence).updateByAssociations === 'function'
        && typeof (value as IPersistence).create === 'function';
}
