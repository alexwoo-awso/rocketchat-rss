export interface RssFeedItem {
    key: string;
    title: string;
    url?: string;
    summary?: string;
    publishedAt?: string;
    author?: string;
}

export interface ParsedRssFeed {
    title: string;
    description?: string;
    siteUrl?: string;
    items: Array<RssFeedItem>;
}

export interface RssDeliveryIdentityConfig {
    avatarUrl?: string;
    displayName?: string;
    senderUsername?: string;
}

export interface RssSubscription {
    id: string;
    feedUrl: string;
    roomId: string;
    roomName: string;
    intervalMinutes: number;
    isPaused: boolean;
    createdAt: string;
    updatedAt: string;
    nextRunAt: string;
    recentItemKeys: Array<string>;
    feedTitle?: string;
    lastCheckedAt?: string;
    lastSuccessAt?: string;
    lastPostedAt?: string;
    lastError?: string;
    identityConfig?: RssDeliveryIdentityConfig;
}

export interface ProcessSubscriptionResult {
    subscription: RssSubscription;
    feedTitle?: string;
    deliveredCount: number;
    detectedCount: number;
    bootstrapItemCount: number;
    dryRun: boolean;
    skipped?: string;
    error?: string;
}

export interface RssChannelConfig {
    roomId: string;
    roomName: string;
    updatedAt: string;
    identityConfig?: RssDeliveryIdentityConfig;
}
