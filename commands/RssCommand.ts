import {
    IHttp,
    IModify,
    IPersistence,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import {
    ISlashCommand,
    SlashCommandContext,
} from '@rocket.chat/apps-engine/definition/slashcommands';

import { RssFeedApp } from '../RssFeedApp';
import { RssFeedService } from '../lib/RssFeedService';

export class RssCommand implements ISlashCommand {
    public command = 'rss';
    public i18nParamsExample = 'help | subscribe <feed-url> [#channel] | config global set logo <https://...>';
    public i18nDescription = 'Manage RSS feed subscriptions';
    public providesPreview = false;

    constructor(private readonly app: RssFeedApp) {}

    public async executor(context: SlashCommandContext, read: IRead, modify: IModify, http: IHttp, persistence: IPersistence): Promise<void> {
        const service = new RssFeedService(this.app);
        try {
            const response = await service.handleCommand(context, read, modify, http, persistence);
            await this.sendMessage(context, modify, response);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unexpected RSS command error.';
            this.app.getLogger().error(`RSS command failed: ${message}`);
            await this.sendMessage(context, modify, `RSS command failed: ${message}`);
        }
    }

    private async sendMessage(context: SlashCommandContext, modify: IModify, text: string): Promise<void> {
        const messageBuilder = modify.getCreator().startMessage();
        messageBuilder
            .setSender(context.getSender())
            .setRoom(context.getRoom())
            .setText(text);

        await modify.getCreator().finish(messageBuilder);
    }
}
