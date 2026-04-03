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
    IUser,
} from '@rocket.chat/apps-engine/definition/users';

import {
    DEFAULT_SCHEDULER_INTERVAL,
    MAX_RECENT_ITEM_KEYS,
    RSS_POLL_PROCESSOR_ID,
} from './constants';
import {
    RssConfigStore,
} from './RssConfigStore';
import {
    RssFeedReader,
} from './RssFeedReader';
import {
    logRss,
} from './RssLogger';
import {
    RssSubscriptionStore,
} from './RssSubscriptionStore';
import {
    ProcessSubscriptionResult,
    RssDeliveryIdentityConfig,
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
        await this.logSchedulerAccessorState(read, accessors);

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
                    await this.logUnexpectedError(
                        read,
                        `Unexpected scheduler failure for subscription ${subscription.id} (${subscription.feedUrl})`,
                        error,
                    );
                }
            }
        } catch (error) {
            await this.logUnexpectedError(read, 'RSS scheduler processor failed before subscription processing started', error);
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
            const pinItems = Boolean(await read.getEnvironmentReader().getSettings().getValueById(RssSetting.DefaultUserPinning));
            const deliveredCount = isBootstrap
                ? 0
                : await this.deliverItems(subscription, feed.title, newItems, read, modify, persistence, dryRun, pinItems);

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
            }, read);

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

            await this.saveSubscription(store, updatedSubscription, read, `Unable to persist failed RSS subscription ${subscription.id}`);
            await this.logUnexpectedError(read, `RSS poll failed for ${subscription.feedUrl}: ${message}`, error);

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
        persistence: IPersistence | undefined,
        dryRun: boolean,
        pinItems: boolean,
    ): Promise<number> {
        if (!items.length || dryRun) {
            return 0;
        }

        if (!modify) {
            throw new Error('Message creator accessor is unavailable in the scheduler context.');
        }

        const room = await read.getRoomReader().getById(subscription.roomId);
        const identityConfig = await this.resolveIdentityConfig(subscription, read, persistence);
        const sender = await this.resolveSender(identityConfig, read);
        if (!room || !sender) {
            throw new Error('Target room or sender user is unavailable.');
        }

        for (const item of items) {
            const hasAttachment = Boolean(item.summary || item.author || item.publishedAt);
            const builder = modify.getCreator().startMessage();
            builder
                .setRoom(room)
                .setSender(sender)
                .setGroupable(false)
                .setText(this.buildMessageText(feedTitle, item, hasAttachment));

            if (identityConfig.displayName) {
                builder.setUsernameAlias(identityConfig.displayName);
            }

            if (identityConfig.avatarUrl) {
                builder.setAvatarUrl(identityConfig.avatarUrl);
            }

            if (hasAttachment) {
                builder.addAttachment({
                    color: '#1d74f5',
                    title: {
                        value: item.title,
                        link: item.url,
                    },
                    text: item.summary ? truncate(item.summary, 350) : undefined,
                    author: item.author ? { name: item.author } : undefined,
                    timestamp: item.publishedAt ? new Date(item.publishedAt) : undefined,
                });
            }

            if (pinItems) {
                builder.setData({
                    ...builder.getMessage(),
                    pinned: true,
                    pinnedAt: new Date(),
                    pinnedBy: {
                        _id: sender.id,
                        username: sender.username,
                        name: sender.name,
                    },
                });
            }

            await modify.getCreator().finish(builder);
        }

        return items.length;
    }

    private buildMessageText(feedTitle: string, item: RssFeedItem, hasAttachment: boolean): string {
        if (hasAttachment) {
            return `**${feedTitle}**`;
        }

        const lines = [
            `**${feedTitle}**`,
            item.url ? `<${item.url}|${item.title}>` : item.title,
        ];

        if (item.summary) {
            lines.push(truncate(item.summary, 350));
        }

        return lines.join('\n');
    }

    private async resolveIdentityConfig(
        subscription: RssSubscription,
        read: IRead,
        persistence: IPersistence | undefined,
    ): Promise<RssDeliveryIdentityConfig> {
        const configStore = new RssConfigStore(read, persistence);
        const [globalConfig, channelConfig] = await Promise.all([
            configStore.getGlobal(),
            configStore.getChannel(subscription.roomId),
        ]);

        return {
            avatarUrl: subscription.identityConfig?.avatarUrl ?? channelConfig?.identityConfig?.avatarUrl ?? globalConfig.avatarUrl,
            displayName: subscription.identityConfig?.displayName ?? channelConfig?.identityConfig?.displayName ?? globalConfig.displayName,
            senderUsername: normalizeSenderUsername(
                subscription.identityConfig?.senderUsername,
                channelConfig?.identityConfig?.senderUsername,
                globalConfig.senderUsername,
            ),
        };
    }

    private async resolveSender(identityConfig: RssDeliveryIdentityConfig, read: IRead): Promise<IUser | undefined> {
        if (identityConfig.senderUsername) {
            try {
                return await read.getUserReader().getByUsername(identityConfig.senderUsername);
            } catch (error) {
                await this.logUnexpectedError(read, `Unable to load configured sender @${identityConfig.senderUsername}`, error);
            }
        }

        return read.getUserReader().getAppUser();
    }

    private async saveSubscription(
        store: RssSubscriptionStore,
        subscription: RssSubscription,
        read: IRead,
        errorPrefix = `Unable to persist RSS subscription ${subscription.id}`,
    ): Promise<void> {
        try {
            await store.save(subscription);
        } catch (error) {
            await this.logUnexpectedError(read, errorPrefix, error);
        }
    }

    private async logUnexpectedError(read: IRead, prefix: string, error: unknown): Promise<void> {
        if (error instanceof Error) {
            const detail = error.stack ?? error.message;
            await logRss(this.app, read, 'error', `${prefix}: ${detail}`);
            return;
        }

        await logRss(this.app, read, 'error', `${prefix}: ${String(error)}`);
    }

    private async logSchedulerAccessorState(read: IRead, accessors: {
        modify: IModify | undefined;
        http: IHttp | undefined;
        persistence: IPersistence | undefined;
    }): Promise<void> {
        if (accessors.modify && accessors.http && accessors.persistence) {
            return;
        }

        await logRss(
            this.app,
            read,
            'warn',
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

function normalizeSenderUsername(...values: Array<string | undefined>): string | undefined {
    for (const value of values) {
        const trimmed = value?.trim();
        if (!trimmed || trimmed === 'app') {
            continue;
        }

        return trimmed.replace(/^@/, '');
    }

    return undefined;
}
